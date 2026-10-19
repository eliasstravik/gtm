import { allowedHosts, isHosted, LOOPBACK_HOSTS, safeEqual, value } from "../shared/env.js";
import { type Bypass, carriesBypass, PROBE_PATH, PROTECTED_STATUSES, requestHost } from "../shared/request.js";

export { type Bypass, carriesBypass, PROBE_PATH, PROTECTED_STATUSES, requestHost } from "../shared/request.js";

/**
 * Whether `/.well-known/workflow/*` skips the hosted fail-closed check. False (they are checked like every page)
 * until spike 1b shows those routes refuse outside callers on an unprotected deployment.
 */
export const WORKFLOW_ROUTES_SELF_PROTECTED = false;
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
  const originHost = origin === null ? host : URL.canParse(origin) ? new URL(origin).host.toLowerCase() : ""; // "null" or junk
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
