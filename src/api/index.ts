/**
 * `gtm({ workflows })`: the handler behind app/api/gtm/[...path]/route.ts. Console read endpoints, start/runs/cron and
 * Connections (plan §3, §4). Every response is `cache-control: no-store`; errors are `{ error }`.
 */
import { isHosted, LOOPBACK_HOSTS, safeEqual, value } from "../shared/env.js";
import { BYPASS, carriesBypass } from "../shared/request.js";
import { listConnections, releaseStatus, saveConnection } from "./connections.js";
import { HttpError, json } from "./http.js";
import { contextFile, contextList, dataExport, dataPage, dataTables, shell } from "./read.js";
import { cronRun, type Registry, runsList, runStatus, startRun, workflowsList } from "./runs.js";

export type { Registry } from "./runs.js";

type Handler = (req: Request, ctx: { params: Promise<{ path?: string[] }> }) => Promise<Response>;

const hostOf = (h: string) => h.split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();

/**
 * Local start/runs answer only on 127.0.0.1/localhost, never on a GTM_ALLOWED_HOSTS host (others on that network must
 * not run stages on the owner's subscription), and never for a cross-site browser request.
 */
function localCaller(req: Request): boolean {
  const [host, forwarded, origin, site] = ["host", "x-forwarded-host", "origin", "sec-fetch-site"].map((h) => req.headers.get(h));
  const loopback = (h: string | null) => !h || LOOPBACK_HOSTS.includes(hostOf(h));
  if (!host || !loopback(host) || !loopback(forwarded)) return false;
  if (origin && !(URL.canParse(origin) && LOOPBACK_HOSTS.includes(new URL(origin).hostname))) return false;
  return !site || site === "same-origin" || site === "none";
}

/** Route handlers for every /api/gtm/* path. */
export function gtm({ workflows }: { workflows: Registry }): { GET: Handler; POST: Handler } {
  const handle: Handler = async (req, ctx) => {
    try {
      const [head, ...rest] = (await ctx.params).path ?? [];
      const url = new URL(req.url);
      const get = req.method === "GET" || req.method === "HEAD";
      const one = rest.length === 1 ? rest[0] : undefined;
      const hosted = isHosted();

      if (head === "cron" && one && get) return await cronRun(req, workflows, one);
      if (one && ((head === "start" && req.method === "POST") || (head === "runs" && get))) {
        // Hosted: only the laptop's bypass header (exactly VERCEL_AUTOMATION_BYPASS_SECRET); browser sessions never.
        const allowed = hosted ? safeEqual(req.headers.get(BYPASS), value("VERCEL_AUTOMATION_BYPASS_SECRET")) : localCaller(req);
        if (!allowed) {
          throw new HttpError(403, hosted
            ? `${head} needs the ${BYPASS} header set to this deployment's automation bypass secret (gtm run --prod)`
            : `${head} answers only on 127.0.0.1 or localhost (gtm run)`);
        }
        return head === "start" ? await startRun(req, workflows, one) : await runStatus(one);
      }

      // Defence in depth behind the proxy: a bypass holder (webhook vendor, Slack) never reads the Console.
      if (hosted && carriesBypass(req)) throw new HttpError(403, "Requests carrying a protection bypass cannot read the Console");
      if (head === "connections" && !rest.length) {
        if (req.method === "POST") return await saveConnection(req);
        if (get) return await listConnections(req);
      }
      if (!get) throw new HttpError(405, "The Console is read-only");
      if (head === "shell" && !rest.length) return await shell();
      if (head === "release" && !rest.length) return await releaseStatus(url.searchParams);
      if (head === "context" && !rest.length) return await contextList();
      if (head === "context" && one === "file") return await contextFile(url.searchParams.get("path"));
      if (head === "workflows" && !rest.length) return await workflowsList(workflows);
      if (head === "workflows" && one === "runs") return await runsList(workflows, url.searchParams);
      if (head === "data" && !rest.length) return await dataTables();
      if (head === "data" && one) return await dataPage(one, url.searchParams);
      if (head === "data" && rest.length === 2) return await dataExport(rest[0], rest[1], url.searchParams);
      throw new HttpError(404, `No such endpoint: /api/gtm/${[head, ...rest].join("/")}`);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("[gtm] API error", error);
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
  return { GET: handle, POST: handle };
}
