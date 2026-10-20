import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { environment, isHosted, PULL_PLACEHOLDER, safeEqual, value } from "../shared/env.js";
import { jwtClaims, PROBE_PATH, PROTECTED_STATUSES, requestHost, vercelJwts } from "../shared/request.js";
import type { Registry } from "./runs.js";
import { dashboardUrl, vercelApi } from "./vercel.js";

/** The fixed contents of `public/_gtm/probe.txt`. */
export const PROBE_TEXT = "gtm-probe-v1";
const PRIVATE = "Changes need a browser signed in through Vercel's login on this domain (not a bypass, token or automation call).";
const settingsUrl = () => dashboardUrl("/settings/environment-variables", "Environment Variables");

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
const enc = encodeURIComponent;

const file = (name: string, dir = process.cwd()) => join(/*turbopackIgnore: true*/ dir, name);
const readText = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), "utf8") : "");
/** Matches a `NAME=` (or `export NAME=`) line. */
const assigns = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);

/**
 * Connections from `.env.example`: every `NAME=` line (optionally `export NAME=`) is one; the `#` comment on the line
 * directly above it is its description (no comment, or a blank line between, means none). First occurrence wins.
 */
export function exampleConnections(dir = process.cwd()): { name: string; description: string }[] {
  const path = file(".env.example", dir), found = new Map<string, string>();
  let comment = "";
  for (const line of existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : []) {
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

/** Names with a value in `.env.local` (Vercel's pull placeholder counts as none). */
function envLocalNames(): string[] {
  try { return Object.entries(parseEnv(readText(".env.local"))).filter(([, v]) => v && v !== PULL_PLACEHOLDER).map(([k]) => k); } catch { return []; }
}

type Change = { action: "save" | "rename" | "delete" | "redeploy"; name: string; value?: string; label?: string };

function checkInput(body: unknown, hosted: boolean): Change {
  const { action = "save", name, value: v, label } = (body ?? {}) as Record<string, unknown>;
  insist(["save", "rename", "delete", "redeploy"].includes(action as string), "Send JSON { action, name, value?, label? }.", 400);
  if (action === "redeploy") return { action, name: "" };
  insist(typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name), "The key takes letters, digits and _ and cannot start with a digit.", 400);
  insist(!refusedName(name, hosted), `${name} cannot be changed from the Console: gtm, Vercel or an integration sets DATABASE_URL*, ` +
    `POSTGRES_*, PG*, CRON_SECRET, GTM_*, VERCEL_*, SLACK_*, GITHUB_* and EVE_*${hosted ? " (and AI_GATEWAY_* here)" : ""}.`, 400);
  insist(label === undefined || (typeof label === "string" && label.trim().length <= 256 && !/[\0-\x1f\x7f]/.test(label)),
    "The name must be one line of at most 256 characters.", 400);
  insist(action !== "rename" || (label as string | undefined)?.trim(), "Send the new name.", 400);
  if (action === "save") {
    insist(typeof v === "string", "Send JSON { name, value }.", 400);
    insist(v.length > 0 && v.length <= 32_768, "The value is empty or too long.", 400);
    insist(!/[\r\n\0]/.test(v), "The value must be one line.", 400);
    insist(!(v.includes("'") && v.includes("`")), "The value cannot contain both ' and `.", 400);
    insist(!v.endsWith("\\"), "The value cannot end in \\.", 400);
  }
  return { action: action as Change["action"], name, value: action === "save" ? (v as string) : undefined, label: (label as string | undefined)?.trim() };
}

/** Written beside the file and renamed over it (a crash never leaves half a file); the temp name is gitignored (.env*.local). */
function writeAtomic(name: string, text: string, mode: number): void {
  const temp = file(`.env.gtm-${randomUUID()}.local`);
  writeFileSync(temp, text, { mode, flag: "wx" });
  try { renameSync(temp, file(name)); chmodSync(file(name), mode); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/**
 * The last line of the entry starting at line `i`: a quoted value runs over several lines up to its closing quote, as
 * @next/env (and Node's parseEnv) read it; an unclosed quote ends with its line.
 */
function entryEnd(lines: string[], i: number): number {
  const rest = lines.slice(i).join("\n"), open = /^\s*(?:export\s+)?[\w.-]+\s*=\s*(["'`])/.exec(rest);
  const close = open && new RegExp(`(?<!\\\\)${open[1]}`).exec(rest.slice(open[0].length));
  return close ? i + rest.slice(0, open![0].length + close.index).split("\n").length - 1 : i;
}

/**
 * NAME='value' (backticks when it contains ') in .env.local, `$` escaped so @next/env reads it back as is; null removes
 * it. Every earlier NAME entry goes whole, each line of a multiline value too, so no part of an old value stays.
 */
function writeEnvLocal(name: string, v: string | null): void {
  const q = v?.includes("'") ? "`" : "'", re = assigns(name), lines = readText(".env.local").split("\n");
  const entry = v === null ? [] : [`${name}=${q}${v.replaceAll("$", "\\$")}${q}`], next: string[] = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const end = /^\s*(?:export\s+)?[\w.-]+\s*=/.test(lines[i]) ? entryEnd(lines, i) : i;
    if (re.test(lines[i])) { if (!found) next.push(...entry); found = true; }
    else next.push(...lines.slice(i, end + 1));
    i = end;
  }
  if (v === null && !found) return;
  if (!found) { if (next.at(-1) === "") next.pop(); next.push(...entry, ""); }
  writeAtomic(".env.local", next.join("\n"), 0o600);
}

/**
 * `.env.example` keeps the list in the repo: `label` becomes the `#` comment directly above NAME (NAME= is appended when
 * missing; "" leaves the comment as it is), and null removes NAME with its comment.
 */
function writeExample(name: string, label: string | null): void {
  const lines = readText(".env.example").split("\n"), re = assigns(name), above = (i: number) => i > 0 && /^\s*#/.test(lines[i - 1]);
  let at = lines.findIndex((l) => re.test(l));
  if (label === null) {
    if (at < 0) return;
    for (; at >= 0; at = lines.findIndex((l) => re.test(l))) lines.splice(above(at) ? at - 1 : at, above(at) ? 2 : 1);
  } else if (at < 0) {
    if (lines.at(-1) === "") lines.pop();
    if (lines.length && /^\s*#/.test(lines.at(-1)!)) lines.push(""); // not under a heading comment
    lines.push(...(label ? [`# ${label}`] : []), `${name}=`, "");
  } else if (!label || lines[at - 1] === `# ${label}`) return;
  else if (above(at)) lines[at - 1] = `# ${label}`;
  else lines.splice(at, 0, `# ${label}`);
  writeAtomic(".env.example", lines.join("\n"), existsSync(file(".env.example")) ? statSync(file(".env.example")).mode & 0o777 : 0o644);
}

/** A Vercel REST call with the project token; failures carry the status and Vercel's error code, never the body. */
const vercel = <T>(token: string, path: string, init?: { method?: string; body?: unknown }) =>
  vercelApi<T>(token, path, init).catch((e: Error) => { throw new Refused(e.message, 502); });

let teamIdCache: string | undefined;
/** The project's team (accountId), looked up once per instance. */
async function teamId(token: string, projectId: string): Promise<string> {
  teamIdCache ??= (await vercel<{ accountId: string }>(token, `/v9/projects/${enc(projectId)}`)).accountId;
  insist(teamIdCache, "The Vercel API did not name this project's team.", 502);
  return teamIdCache;
}

type EnvVar = { id: string; key: string; type?: string; target?: string[] | string; customEnvironmentIds?: string[]; gitBranch?: string;
  comment?: string; configurationId?: string | null; integrationId?: string; sharedEnvVariableId?: string; system?: boolean };
type Production = { id: string; comment: string; editable: boolean };

/**
 * The project's Production variables by name, never values. Editable: the variable is Production's alone and the
 * project's own; one shared with other environments, an integration's, a shared or a system one is changed in Vercel.
 */
async function productionVars(token: string, projectId: string): Promise<Map<string, Production>> {
  const team = await teamId(token, projectId);
  const { envs = [] } = await vercel<{ envs?: EnvVar[] }>(token, `/v10/projects/${enc(projectId)}/env?teamId=${enc(team)}`);
  const prod = envs.filter((e) => [e.target ?? []].flat().includes("production") && !refusedName(e.key, true));
  return new Map(prod.map((e) => [e.key, {
    id: e.id, comment: typeof e.comment === "string" ? e.comment.slice(0, 256) : "",
    editable: [e.target].flat().length === 1 && !e.customEnvironmentIds?.length && !e.gitBranch && !e.configurationId && !e.integrationId &&
      !e.sharedEnvVariableId && !e.system && e.type !== "system" && prod.filter((o) => o.key === e.key).length === 1,
  }]));
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
    return { save: { mode: "off", reason: `Changes work only on the production domain${where}, where Vercel's login is.` } };
  }
  const token = value("GTM_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID");
  if (!token || !projectId) return { save: { mode: "link", settingsUrl: (await settingsUrl()) ?? undefined } };
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

type Deployment = { uid: string; url: string; readyState?: string };
/** `redeploy`: "started" with the deployment's id, or "skipped"/"failed", which the Console offers to retry. */
type Done = { ok: true; status: string; id?: string; deploymentUrl?: string; redeploy?: "started" | "skipped" | "failed"; shell?: boolean };

/** Redeploys the newest production deployment so it picks up Production's variables; `done` opens the status. */
async function redeploy(s: Session, done: string): Promise<Done> {
  const id = enc(s.projectId), team = `teamId=${enc(s.team)}`, then = (text: string) => `${done ? `${done} ` : ""}${text}`;
  const project = await vercel<{ name: string; autoAssignCustomDomains?: boolean }>(s.token, `/v9/projects/${id}?${team}`);
  // An Instant Rollback pins production: Vercel turns production auto-assign off until it is undone.
  if (project.autoAssignCustomDomains === false) {
    return { ok: true, redeploy: "skipped", status: then("Production is pinned by a rollback, so nothing was redeployed. Undo the rollback in Vercel, then redeploy.") };
  }
  const { deployments = [] } = await vercel<{ deployments?: Deployment[] }>(s.token, `/v6/deployments?projectId=${id}&target=production&limit=10&${team}`);
  // Even a build already in flight keeps the old value (spike 1d), so the newest deployable one is redeployed whatever its
  // state. ERROR, CANCELED, DELETED and BLOCKED (a git commit Vercel refused) ones can never deploy again.
  const newest = deployments.find((d) => ["READY", "BUILDING", "INITIALIZING", "QUEUED"].includes(d.readyState ?? ""));
  if (!newest) return { ok: true, status: then("There is no production deployment to redeploy yet; the next one uses it.") };
  const created = await vercel<{ id: string; url: string; readyState?: string }>(s.token, `/v13/deployments?${team}`,
    { body: { name: project.name, deploymentId: newest.uid, target: "production" } }).catch((e: Error) => e);
  if (created instanceof Error) return { ok: true, redeploy: "failed", status: then(`The redeploy failed: ${created.message}`) };
  return { ok: true, redeploy: "started", status: then(`Production is redeploying (${(created.readyState ?? "queued").toLowerCase()}).`),
    id: created.id, deploymentUrl: `https://${created.url}` };
}

/**
 * Hosted: save upserts the Production-only Secret with the name as its comment, rename changes only the comment, delete
 * removes the variable; save and delete then redeploy, and redeploy retries only that. Others' variables are refused.
 */
async function changeHosted(s: Session, c: Change): Promise<Done> {
  if (c.action === "redeploy") return redeploy(s, "");
  const row = (await productionVars(s.token, s.projectId)).get(c.name), base = `/v9/projects/${enc(s.projectId)}/env`, team = `teamId=${enc(s.team)}`;
  // Upsert silently splits a production variable shared with other environments (spike 1d), so those are refused.
  insist(!row || row.editable, `${c.name} is shared with other environments or owned by Vercel or an integration; change it in the Vercel dashboard: ${await settingsUrl()}`, 409);
  if (c.action !== "save") insist(row, `${c.name} is not a Production variable yet; add it first.`, 404);
  if (c.action === "rename") {
    await vercel(s.token, `${base}/${enc(row!.id)}?${team}`, { method: "PATCH", body: { comment: c.label } });
    return { ok: true, status: "Renamed." };
  }
  if (c.action === "delete") {
    await vercel(s.token, `${base}/${enc(row!.id)}?${team}`, { method: "DELETE" });
    return redeploy(s, "Deleted.");
  }
  const comment = c.label || row?.comment;
  await vercel(s.token, `/v10/projects/${enc(s.projectId)}/env?upsert=true&${team}`,
    { body: { key: c.name, value: c.value, type: "sensitive", target: ["production"], ...(comment && { comment }) } });
  return redeploy(s, "Saved.");
}

/** Locally: .env.local holds the value, .env.example the name and its label. */
function changeLocal(c: Change): Done {
  insist(c.action !== "redeploy", "Nothing redeploys on this computer.", 400);
  const shell = (value("GTM_SHELL_KEYS") ?? "").split(",").includes(c.name);
  if (c.action === "delete") {
    insist(envLocalNames().includes(c.name) || exampleConnections().some((e) => e.name === c.name), `${c.name} is not in .env.local or .env.example.`, 404);
    writeEnvLocal(c.name, null); writeExample(c.name, null);
    return { ok: true, status: "Deleted from .env.local and .env.example.", shell };
  }
  if (c.action === "save") writeEnvLocal(c.name, c.value!);
  writeExample(c.name, c.label ?? "");
  return { ok: true, status: c.action === "save" ? "Saved to .env.local." : "Renamed in .env.example.", shell };
}

type State = "set" | "missing" | "saved" | "provided" | "readonly";

/** The sidebar's count: names `.env.example` lists or workflows declare that are not set here (AI Gateway hosted is). */
export function missingConnections(workflows: Registry): number {
  const declared = Object.values(workflows).flatMap((e) => (typeof e === "function" ? [] : e.connections ?? []));
  const names = new Set([...exampleConnections().map((c) => c.name), ...declared]);
  return [...names].filter((n) => value(n) === undefined && !(isHosted() && /^AI_GATEWAY_/i.test(n))).length;
}

/**
 * GET /api/gtm/connections: every connection by name and label, never a value: `.env.example`'s names, those set in
 * `.env.local` (locally) or in Vercel's Production env (hosted, with GTM_VERCEL_TOKEN), and those workflows declare.
 * Each with its state here, the workflows using it, and the changes allowed (`actions`). Missing ones first.
 */
export async function listConnections(req: Request, workflows: Registry = {}): Promise<Response> {
  const hosted = isHosted(), { save } = await access(req), token = value("GTM_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID");
  const example = new Map(exampleConnections().map((c) => [c.name, c.description])), local = hosted ? [] : envLocalNames();
  let vars = new Map<string, Production>(), listError: string | null = null;
  if (hosted && process.env.VERCEL_ENV === "production" && token && projectId) {
    vars = await productionVars(token, projectId).catch((e: Error) => { listError = `Could not read Production's variables: ${e.message}`; return vars; });
  }
  const entries = Object.entries(workflows).map(([id, e]) => [id, typeof e === "function" ? undefined : e.connections] as const);
  const usedBy = (name: string) => entries.filter(([, uses]) => uses?.includes(name)).map(([id]) => id);
  const shell = (value("GTM_SHELL_KEYS") ?? "").split(",");
  const canChange = save.mode === "local" || save.mode === "hosted";
  const names = [...new Set([...example.keys(), ...local.filter((n) => !refusedName(n, false)), ...vars.keys(), ...entries.flatMap(([, u]) => u ?? [])])];
  const connections = names.map((name) => {
    const row = vars.get(name), reserved = refusedName(name, hosted), set = value(name) !== undefined;
    const state: State = hosted && !set && /^AI_GATEWAY_/i.test(name) ? "provided" : row && !row.editable ? "readonly"
      : set ? "set" : row || local.includes(name) ? "saved" : "missing";
    const actions = !canChange || reserved || state === "provided" || state === "readonly" ? []
      : hosted ? (row ? ["save", "rename", "delete"] : ["save"])
      : ["save", "rename", ...(example.has(name) || local.includes(name) ? ["delete"] : [])];
    return { name, description: row?.comment || example.get(name) || "", set: set || state === "provided", state, usedBy: usedBy(name), actions,
      ...(reserved && { reserved: true }), ...(!hosted && shell.includes(name) && { shell: true }) };
  }).sort((a, b) => Number(b.state === "missing") - Number(a.state === "missing"));
  return reply({ connections, environment: environment(), save, tokenWarning: tokenWarning(), listError,
    settingsUrl: await settingsUrl(), usageComplete: entries.every(([, uses]) => Array.isArray(uses)) });
}

/**
 * POST /api/gtm/connections { action: "save" | "rename" | "delete" | "redeploy", name, value?, label? } ({ name, value }
 * is a save): locally .env.local and .env.example, hosted Vercel's Production env. Values are never logged, echoed or kept.
 */
export async function saveConnection(req: Request): Promise<Response> {
  try {
    const hosted = isHosted();
    insist(isJson(req), "Send JSON { action, name, value?, label? }.", 415);
    if (!hosted) {
      const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
      insist((origin === null || hostOf(origin) === requestHost(req)) && (site === null || site === "same-origin"), "Connections accepts same-origin requests only.");
    }
    const { save, session } = await access(req);
    if (hosted) {
      insist(session, save.reason ?? `Changes are off here; use the Vercel dashboard: ${save.settingsUrl ?? await settingsUrl()}`);
      insist(req.headers.get("origin") === session.origin && req.headers.get("sec-fetch-site") === "same-origin" &&
        safeEqual(req.headers.get("x-gtm-csrf"), session.csrf), "The change was refused (cross-site or expired form); reload the page.");
    }
    const change = checkInput(await req.json().catch(() => undefined), hosted);
    const done = session ? await changeHosted(session, change) : changeLocal(change);
    change.value = undefined;
    return reply(done);
  } catch (error) {
    if (error instanceof Refused) return reply({ ok: false, error: error.message }, error.status);
    console.error("[gtm] connections change failed:", error instanceof Error ? error.message : "unknown error");
    return reply({ ok: false, error: "The change failed." }, 500);
  }
}

/** GET /api/gtm/release?id=dpl_… → { release: { state: "updating" | "live" | "failed", details? } | null }: the badge's view
 * of the redeploy a hosted save started. READY but STAGED or ROLLING is built, not yet serving production. */
export async function releaseStatus(params: URLSearchParams): Promise<Response> {
  const token = value("GTM_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID"), id = params.get("id") ?? "";
  if (!isHosted() || !token || !projectId) return reply({ release: null });
  if (!/^dpl_[A-Za-z0-9]{1,64}$/.test(id)) return reply({ error: "Send ?id=dpl_…" }, 400);
  const d = await teamId(token, projectId).then((team) => vercel<{ projectId?: string; readyState?: string; readySubstate?: string;
    inspectorUrl?: string }>(token, `/v13/deployments/${id}?teamId=${enc(team)}`)).catch((e: Refused) => e);
  if (d instanceof Refused || d.projectId !== projectId) return reply({ error: d instanceof Refused ? d.message : "Not this project's deployment." }, 502);
  const state = d.readyState === "ERROR" || d.readyState === "CANCELED" ? "failed"
    : d.readyState === "READY" && (d.readySubstate ?? "PROMOTED") === "PROMOTED" ? "live" : "updating";
  return reply({ release: { state, ...(state === "failed" && d.inspectorUrl?.startsWith("https://") ? { details: d.inspectorUrl } : {}) } });
}
