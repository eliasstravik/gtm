import { allowedHosts, isHosted, LOOPBACK_HOSTS, safeEqual, value } from "../shared/env.js";

/**
 * Whether `/.well-known/workflow/*` skips the hosted fail-closed check. False (they are checked like every page)
 * until spike 1b shows those routes refuse outside callers on an unprotected deployment.
 */
export const WORKFLOW_ROUTES_SELF_PROTECTED = false;
/** Served from `public/`, outside the proxy's matcher; requested by the fail-closed and Save probes. */
export const PROBE_PATH = "/_gtm/probe.txt";
/** Statuses that show Vercel's login stands in front of an anonymous request. */
export const PROTECTED_STATUSES = [301, 302, 303, 307, 308, 401, 403];
const BYPASS = "x-vercel-protection-bypass";
const SET_BYPASS_COOKIE = "x-vercel-set-bypass-cookie";
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_HOSTS = 32;

const NOTICE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Protection required</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1>Turn on Vercel Authentication → All Deployments</h1>
<p>This cockpit stays closed while this deployment can be opened without Vercel's login. In the Vercel dashboard open
Settings → Deployment Protection, set Vercel Authentication to <b>All Deployments</b> and save. This page clears
within 5 minutes.</p></body>`;

const refuse = (error: string, status = 403) =>
  Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });

/** The request's Host header, lower-cased, port included. */
export function requestHost(req: Request): string {
  return (req.headers.get("host") ?? "").toLowerCase();
}

/** Decoded claims of every `_vercel_jwt` cookie on the request ({} for one that does not decode). */
export function vercelJwtClaims(req: Request): Record<string, unknown>[] {
  return (req.headers.get("cookie") ?? "").split(";").map((c) => c.trim()).filter((c) => c.startsWith("_vercel_jwt="))
    .map((c) => {
      try { return JSON.parse(Buffer.from(c.split(".")[1] ?? "", "base64url").toString()) ?? {}; } catch { return {}; }
    });
}

export type Bypass = { header?: string; query: string[]; cookie: boolean };

/**
 * The Protection Bypass a request carries, if any: the `x-vercel-protection-bypass` header or query parameter (any
 * case), or a bypass cookie. Per spike 1d that is a `_vercel_jwt` (the login session's name; its sub is "sso-protection")
 * with a `bypass` claim and sub "protection-bypass-automation" or, for Shareable Links, "protection-bypass-url".
 * A request asking for the cookie (`x-vercel-set-bypass-cookie`) counts as one too.
 */
export function carriesBypass(req: Request): Bypass | undefined {
  const params = [...new URL(req.url).searchParams].map(([k, v]) => [k.toLowerCase(), v]);
  const query = params.filter(([k]) => k === BYPASS).map(([, v]) => v);
  const cookie = req.headers.has(SET_BYPASS_COOKIE) || params.some(([k]) => k === SET_BYPASS_COOKIE) ||
    vercelJwtClaims(req).some((c) => Object.hasOwn(c, "bypass") || String(c.sub).startsWith("protection-bypass"));
  if (!req.headers.has(BYPASS) && !query.length && !cookie) return undefined;
  return { header: req.headers.get(BYPASS) ?? undefined, query, cookie };
}

/**
 * Where a bypass may go (plan §3): webhooks and Slack with their own labeled secret, never the automation one;
 * run start and status only with exactly the automation secret, in the header. The cookie form reaches nothing.
 */
function bypassAllowed(path: string, b: Bypass): boolean {
  const automation = value("VERCEL_AUTOMATION_BYPASS_SECRET");
  if (b.cookie) return false;
  if (path.startsWith("/api/gtm/start/") || path.startsWith("/api/gtm/runs/")) {
    return !b.query.length && safeEqual(b.header, automation);
  }
  if (path.startsWith("/api/hooks/") || path === "/eve/v1/slack") {
    const given = [...new Set([...(b.header === undefined ? [] : [b.header]), ...b.query])];
    return given.length === 1 && given[0] !== "" && !safeEqual(given[0], automation);
  }
  return false;
}

/** Routes that carry their own checks and stay reachable while protection is off. */
function failClosedExempt(path: string): boolean {
  return ["/eve/v1/", "/api/gtm/cron/", "/api/hooks/"].some((p) => path.startsWith(p)) ||
    (WORKFLOW_ROUTES_SELF_PROTECTED && path.startsWith("/.well-known/workflow/"));
}

const probes = new Map<string, { at: number; open: Promise<boolean> }>();

/** Whether `host` serves the probe to an anonymous caller, i.e. Vercel Authentication is off for it. Results are
 * kept 5 minutes per host (at most 32 hosts); a failed probe counts as unprotected and is not kept. */
async function unprotected(host: string): Promise<boolean> {
  const hit = probes.get(host);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.open;
  probes.delete(host);
  const open = fetch(`https://${host}${PROBE_PATH}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000) })
    .then(async (res) => { await res.body?.cancel(); return !PROTECTED_STATUSES.includes(res.status); })
    .catch(() => { probes.delete(host); return true; });
  probes.set(host, { at: Date.now(), open });
  if (probes.size > PROBE_HOSTS) probes.delete(probes.keys().next().value!);
  return open;
}

function local(req: Request): Response | undefined {
  const host = requestHost(req);
  if (![...LOOPBACK_HOSTS, ...allowedHosts()].includes(host.replace(/:\d+$/, ""))) {
    return refuse("This host is not allowed. To admit a private hostname, add it to GTM_ALLOWED_HOSTS.");
  }
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const site = req.headers.get("sec-fetch-site"), origin = req.headers.get("origin");
  let originHost = "";
  try { originHost = origin === null ? host : new URL(origin).host.toLowerCase(); } catch { /* "null" or junk */ }
  if (site === "cross-site" || site === "same-site" || originHost !== host) return refuse("Cross-site requests are refused.");
  return undefined;
}

/**
 * The Next.js proxy guard (plan §3). Local: loopback or GTM_ALLOWED_HOSTS only, and no cross-site writes, on every
 * route. Hosted: bypass-carrying requests reach only their own routes, and every other page and endpoint answers
 * 503 while an anonymous request gets past Vercel's login. Returns a response to stop, or undefined to continue.
 */
export async function gtmProxy(req: Request): Promise<Response | undefined> {
  if (!isHosted()) return local(req);
  const path = new URL(req.url).pathname;
  if (path === PROBE_PATH) return undefined;
  const bypass = carriesBypass(req);
  if (bypass && !bypassAllowed(path, bypass)) {
    return refuse("Requests carrying a Vercel protection bypass can reach only webhooks, Slack, and run start and status.");
  }
  if (failClosedExempt(path)) return undefined;
  const host = requestHost(req);
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return refuse("Bad Host header.", 400);
  if (!(await unprotected(host))) return undefined;
  return new Response(NOTICE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
