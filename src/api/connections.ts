import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHosted, safeEqual, value } from "../shared/env.js";
import { jwtClaims, PROBE_PATH, PROTECTED_STATUSES, requestHost, vercelJwts } from "../shared/request.js";

/** The fixed contents of `public/_gtm/probe.txt`. */
export const PROBE_TEXT = "gtm-probe-v1";
const API = "https://api.vercel.com";
const SETTINGS_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Environment+Variables";
const PRIVATE = "Save needs a browser signed in through Vercel's login on this domain (not a bypass, token or automation call).";

/** Headers on every Connections response. */
export const connectionHeaders = {
  "cache-control": "private, no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY",
};

class Refused extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}
function insist(ok: unknown, message: string, status = 403): asserts ok {
  if (!ok) throw new Refused(message, status);
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: connectionHeaders });
const hostOf = (origin: string) => { try { return new URL(origin).host.toLowerCase(); } catch { return ""; } };
const isJson = (req: Request) => req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

/**
 * Connections from `.env.example`: every `NAME=` line (optionally `export NAME=`) is one; the `#` comment on the line
 * directly above it is its description (no comment, or a blank line between, means none). First occurrence wins.
 */
export function exampleConnections(dir = process.cwd()): { name: string; description: string }[] {
  const file = join(/*turbopackIgnore: true*/ dir, ".env.example"), found = new Map<string, string>();
  let comment = "";
  for (const line of existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : []) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !found.has(m[1])) found.set(m[1], comment);
    comment = /^\s*#/.test(line) ? line.replace(/^\s*#+/, "").trim() : "";
  }
  return [...found].map(([name, description]) => ({ name, description }));
}

/** Names Save never writes (plan §4); hosted also refuses AI Gateway credentials. */
export function refusedName(name: string, hosted = isHosted()): boolean {
  const n = name.toUpperCase();
  return /^(DATABASE_URL|POSTGRES_|PG|GTM_|VERCEL_|SLACK_|GITHUB_|EVE_)|^CRON_SECRET$/.test(n) || (hosted && n.startsWith("AI_GATEWAY_"));
}

function checkInput(body: unknown, hosted: boolean): { name: string; value: string } {
  const { name, value: v } = (body ?? {}) as { name?: unknown; value?: unknown };
  insist(typeof name === "string" && typeof v === "string", "Send JSON { name, value }.", 400);
  insist(!refusedName(name, hosted), `${name} cannot be saved from the cockpit.`, 400);
  insist(exampleConnections().some((c) => c.name === name), `${name} is not listed in .env.example.`, 400);
  insist(v.length > 0 && v.length <= 32_768, "The value is empty or too long.", 400);
  insist(!/[\r\n\0]/.test(v), "The value must be one line.", 400);
  insist(!(v.includes("'") && v.includes("`")), "The value cannot contain both ' and `.", 400);
  insist(!v.endsWith("\\"), "The value cannot end in \\.", 400);
  return { name, value: v };
}

/** Writes NAME='value' (backticks when it contains ') into .env.local, `$` escaped so @next/env reads it back as is. */
function writeEnvLocal(name: string, v: string, dir = process.cwd()): void {
  const file = join(/*turbopackIgnore: true*/ dir, ".env.local"), q = v.includes("'") ? "`" : "'";
  const entry = `${name}=${q}${v.replaceAll("$", "\\$")}${q}`, re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const at = lines.findIndex((l) => re.test(l));
  const next = at < 0 ? [...lines.slice(0, lines.at(-1) === "" ? -1 : undefined), entry, ""]
    : lines.flatMap((l, i) => (i === at ? [entry] : re.test(l) ? [] : [l]));
  writeFileSync(file, next.join("\n"), { mode: 0o600 });
}

/** A Vercel REST call with the project token; failures carry the status and Vercel's error code, never the body. */
async function vercel<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Refused("Could not reach the Vercel API.", 502); });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
  insist(res.ok, `The Vercel API refused ${path.split("?")[0]} (${res.status}${data.error?.code ? ` ${data.error.code}` : ""}).`, 502);
  return data;
}

let teamIdCache: string | undefined;
/** The project's team (accountId), looked up once per instance. */
async function teamId(token: string, projectId: string): Promise<string> {
  teamIdCache ??= (await vercel<{ accountId: string }>(token, `/v9/projects/${encodeURIComponent(projectId)}`)).accountId;
  insist(teamIdCache, "The Vercel API did not name this project's team.", 502);
  return teamIdCache;
}

/**
 * Ported from the prior owner-session guard. The cookie shape is a fail-closed compatibility check, not a signature
 * check: Vercel itself validates the session when the probe is requested with it, and an anonymous probe must be
 * refused, so turning Deployment Protection off turns hosted Save off. Bypass, bearer and trusted-OIDC callers have
 * no owner session. (Vercel adds `x-vercel-oidc-token` to every function request, so that one is not refused.)
 */
async function ownerSession(req: Request, origin: string, team: string): Promise<string> {
  const url = new URL(req.url), keys = [...url.searchParams.keys()].map((k) => k.toLowerCase());
  for (const name of ["authorization", "x-vercel-protection-bypass", "x-vercel-set-bypass-cookie", "x-vercel-trusted-oidc-idp-token"]) {
    insist(!req.headers.has(name) && !keys.includes(name), PRIVATE);
  }
  const jwts = vercelJwts(req), [jwt] = jwts, cookie = `_vercel_jwt=${jwt}`;
  insist(jwts.length === 1 && jwt.length < 8192 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt), PRIVATE);
  const claims = jwtClaims(jwt);
  insist(!Object.hasOwn(claims, "bypass") && typeof claims.userId === "string" && claims.userId.length > 0 &&
    claims.ownerId === team && claims.aud === new URL(origin).hostname && claims.sub === "sso-protection", PRIVATE);
  const probe = (headers?: Record<string, string>) =>
    fetch(`${origin}${PROBE_PATH}`, { redirect: "manual", cache: "no-store", headers, signal: AbortSignal.timeout(10_000) });
  const [anonymous, signedIn] = await Promise.all([probe(), probe({ cookie })]).catch(() => {
    throw new Refused("Could not verify the Vercel login right now; try again.", 503);
  });
  try {
    insist(PROTECTED_STATUSES.includes(anonymous.status), "Turn on Vercel Authentication → All Deployments to use Save.");
    // trim(): a trailing newline in probe.txt proves the same thing.
    insist(signedIn.status === 200 && (await signedIn.text()).trim() === PROBE_TEXT, PRIVATE);
  } finally { await anonymous.body?.cancel(); if (!signedIn.bodyUsed) await signedIn.body?.cancel(); }
  return jwt;
}

type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; settingsUrl?: string; csrf?: string };
type Session = { origin: string; token: string; projectId: string; team: string; csrf: string };

/** How Save works for this request; hosted, only on the production domain with a verified owner session. */
async function access(req: Request): Promise<{ save: Save; session?: Session }> {
  if (!isHosted()) return { save: { mode: "local" } };
  const prod = value("VERCEL_PROJECT_PRODUCTION_URL")?.toLowerCase();
  if (process.env.VERCEL_ENV !== "production" || !prod || requestHost(req) !== prod) {
    const where = prod && /^[a-z0-9.-]+(:\d+)?$/.test(prod) ? ` (https://${prod})` : "";
    return { save: { mode: "off", reason: `Save works only on the production domain${where}, where Vercel's login is.` } };
  }
  const token = value("GTM_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID");
  if (!token || !projectId) return { save: { mode: "link", settingsUrl: SETTINGS_URL } };
  const origin = `https://${prod}`;
  try {
    const team = await teamId(token, projectId), jwt = await ownerSession(req, origin, team);
    const csrf = createHmac("sha256", token).update(`connections-v1:${origin}:${jwt}`).digest("base64url");
    return { save: { mode: "hosted", csrf }, session: { origin, token, projectId, team, csrf } };
  } catch (error) {
    if (error instanceof Refused) return { save: { mode: "off", reason: error.message } };
    throw error;
  }
}

/** A banner from 14 days before GTM_VERCEL_TOKEN_EXPIRES (or after it), else null. */
function tokenWarning(now = Date.now()): string | null {
  const expires = value("GTM_VERCEL_TOKEN_EXPIRES");
  if (!expires) return null;
  const at = Date.parse(expires), fix = "Create a new project-scoped token and replace GTM_VERCEL_TOKEN and GTM_VERCEL_TOKEN_EXPIRES in Vercel.";
  if (Number.isNaN(at)) return `GTM_VERCEL_TOKEN_EXPIRES is not a date (${expires}). ${fix}`;
  const days = Math.ceil((at - now) / 86_400_000);
  if (days > 14) return null;
  return `${days <= 0 ? "The Vercel token Save uses has expired" : `The Vercel token Save uses expires in ${days} day${days === 1 ? "" : "s"}`} (${expires}). ${fix}`;
}

type EnvVar = { key: string; target?: string[] | string; customEnvironmentIds?: string[] };
type Deployment = { uid: string; url: string; readyState?: string };

/** Writes the value to Production as a sensitive variable, then redeploys the newest production deployment. */
async function saveHosted(s: Session, name: string, v: string): Promise<{ ok: true; status: string; deploymentUrl?: string }> {
  const id = encodeURIComponent(s.projectId), team = `teamId=${encodeURIComponent(s.team)}`;
  const { envs = [] } = await vercel<{ envs?: EnvVar[] }>(s.token, `/v10/projects/${id}/env?${team}`);
  // Upsert silently splits a production variable shared with other environments (spike 1d), so those are refused.
  const shared = envs.some((e) => {
    const targets = [e.target ?? []].flat();
    return e.key === name && targets.includes("production") && (targets.length > 1 || Boolean(e.customEnvironmentIds?.length));
  });
  insist(!shared, `${name} is one variable shared by several environments; change it in the Vercel dashboard: ${SETTINGS_URL}`, 409);
  await vercel(s.token, `/v10/projects/${id}/env?upsert=true&${team}`, { key: name, value: v, type: "sensitive", target: ["production"] });
  const project = await vercel<{ name: string; autoAssignCustomDomains?: boolean }>(s.token, `/v9/projects/${id}?${team}`);
  // An Instant Rollback pins production: Vercel turns production auto-assign off until it is undone.
  if (project.autoAssignCustomDomains === false) {
    return { ok: true, status: "Saved, but production is pinned by a rollback, so nothing was redeployed. Undo the rollback in Vercel to apply it." };
  }
  const { deployments = [] } = await vercel<{ deployments?: Deployment[] }>(s.token, `/v6/deployments?projectId=${id}&target=production&limit=5&${team}`);
  // Even a build already in flight keeps the old value (spike 1d), so the newest usable one is redeployed whatever its state.
  const newest = deployments.find((d) => !["ERROR", "CANCELED", "DELETED"].includes(d.readyState ?? ""));
  if (!newest) return { ok: true, status: "Saved. There is no production deployment to redeploy yet; the next one uses it." };
  const created = await vercel<{ url: string; readyState?: string }>(s.token, `/v13/deployments?${team}`,
    { name: project.name, deploymentId: newest.uid, target: "production" });
  return { ok: true, status: `Saved. Production is redeploying (${(created.readyState ?? "queued").toLowerCase()}).`,
    deploymentUrl: `https://${created.url}` };
}

/** GET /api/gtm/connections: names and descriptions from .env.example, set or missing here, and how Save works. */
export async function listConnections(req: Request): Promise<Response> {
  const { save } = await access(req);
  const connections = exampleConnections().map((c) => ({ ...c, set: value(c.name) !== undefined }));
  return reply({ connections, save, tokenWarning: tokenWarning() });
}

/** POST /api/gtm/connections { name, value }: locally into .env.local, hosted into Vercel's Production env. Values are
 * never logged, echoed or kept. */
export async function saveConnection(req: Request): Promise<Response> {
  try {
    const hosted = isHosted();
    insist(isJson(req), "Send JSON { name, value }.", 415);
    if (!hosted) {
      const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
      insist((origin === null || hostOf(origin) === requestHost(req)) && (site === null || site === "same-origin"), "Save accepts same-origin requests only.");
    }
    const { save, session } = await access(req);
    if (hosted) {
      insist(session, save.reason ?? `Save is off here; add the key in the Vercel dashboard: ${save.settingsUrl ?? SETTINGS_URL}`);
      insist(req.headers.get("origin") === session.origin && req.headers.get("sec-fetch-site") === "same-origin" &&
        safeEqual(req.headers.get("x-gtm-csrf"), session.csrf), "Save was refused (cross-site or expired form); reload the page.");
    }
    const input = checkInput(await req.json().catch(() => undefined), hosted);
    if (!session) {
      writeEnvLocal(input.name, input.value);
      return reply({ ok: true, status: "Saved to .env.local." });
    }
    return reply(await saveHosted(session, input.name, input.value));
  } catch (error) {
    if (error instanceof Refused) return reply({ ok: false, error: error.message }, error.status);
    return reply({ ok: false, error: "Save failed." }, 500);
  }
}
