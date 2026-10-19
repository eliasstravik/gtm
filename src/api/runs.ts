/** Workflows view, start, runs and cron (plan §3, §4), all through the Workflow SDK; never the database. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { parseWorkflowName } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import { environment, isHosted, safeEqual, value } from "../shared/env.js";
import { HttpError, json } from "./http.js";

/** The registry `workflows/index.ts` exports: name → workflow function. */
export type Registry = Record<string, (...args: any[]) => Promise<unknown>>;

type World = Awaited<ReturnType<typeof getWorld>>;
type RunRow = { runId: string; status: string; workflowName: string; errorCode?: string | null; createdAt: Date } & {
  startedAt?: Date | null;
  completedAt?: Date | null;
};

function workflow(workflows: Registry, name: string) {
  const fn = Object.hasOwn(workflows, name) ? workflows[name] : undefined;
  if (typeof fn !== "function") throw new HttpError(404, `No workflow named "${name}" in workflows/index.ts`);
  return fn;
}

/** Workflow name → schedule: vercel.json crons on /api/gtm/cron/<name> unless hosted, then GTM_CRONS from withGtm. */
async function schedules(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    // process.env.GTM_CRONS literally, so the value withGtm inlines at build time is the one read.
    const crons: { workflow?: unknown; schedule?: unknown; path?: unknown }[] = isHosted()
      ? JSON.parse(process.env.GTM_CRONS ?? "[]")
      : (JSON.parse((await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), "vercel.json"), "utf8").catch(() => "")) || "{}").crons ?? []);
    for (const c of crons) {
      const name = c.workflow ?? /^\/api\/gtm\/cron\/([^/?#]+)(?:[?#].*)?$/.exec(String(c.path))?.[1];
      if (typeof name === "string" && typeof c.schedule === "string") map.set(name, map.has(name) ? `${map.get(name)}; ${c.schedule}` : c.schedule);
    }
  } catch {} // an unreadable vercel.json shows no schedules; `gtm check` reports it
  return map;
}

/** The newest 50 runs: world.analytics.runs.list() where the world has it (Vercel), else world.runs.list() (local). */
async function recentRuns(world: World): Promise<RunRow[]> {
  const pagination = { limit: 50, sortOrder: "desc" as const };
  if (world.analytics) {
    try {
      return (await world.analytics.runs.list({ pagination })).data;
    } catch (error) {
      console.error("[gtm] world.analytics.runs.list failed; trying world.runs.list", error);
    }
  }
  return (await world.runs.list({ pagination, resolveData: "none" })).data;
}

/** A failed run's message (the cause WorkflowRunFailedError wraps). */
const failure = (e: { cause?: { message?: unknown }; message?: string }) =>
  typeof e?.cause?.message === "string" ? e.cause.message : (e?.message ?? String(e));

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** GET /workflows → { workflows: [{ name, schedule }], runs: [...], runsUrl }. */
export async function workflowsList(workflows: Registry): Promise<Response> {
  const crons = await schedules();
  // The SWC transform gives each workflow function the `workflowId` that runs record as workflowName.
  const names = new Map(Object.entries(workflows).map(([name, fn]) => [(fn as { workflowId?: string }).workflowId, name]));
  const rows = await getWorld().then(recentRuns).catch((error) => {
    console.error("[gtm] could not list workflow runs", error);
    return [] as RunRow[];
  });
  // List rows carry only an error code. The 10 newest failures get their message: one run read each, and reading
  // returnValue also decompresses and decrypts the stored error.
  const failed = rows.filter((r) => r.status === "failed").slice(0, 10);
  const errors = new Map(await Promise.all(failed.map(async (r) => [r.runId, await getRun(r.runId).returnValue.then(() => null, failure)] as const)));
  const runs = rows.map((r) => ({
    id: r.runId,
    workflow: names.get(r.workflowName) ?? parseWorkflowName(r.workflowName)?.shortName ?? r.workflowName,
    status: r.status,
    startedAt: iso(r.startedAt),
    createdAt: iso(r.createdAt)!,
    completedAt: iso(r.completedAt),
    durationMs: r.completedAt ? new Date(r.completedAt).getTime() - new Date(r.startedAt ?? r.createdAt).getTime() : null,
    error: r.status === "failed" ? (errors.get(r.runId) ?? r.errorCode ?? "failed") : null,
  }));
  // Best effort: deployments know neither team nor project slug, so Vercel's own deep link asks for them.
  const to = encodeURIComponent(`/[team]/[project]/workflows?environment=${environment()}`);
  const runsUrl = isHosted() ? `https://vercel.com/d?to=${to}&title=Workflow+runs` : null;
  return json({ workflows: Object.keys(workflows).map((name) => ({ name, schedule: crons.get(name) ?? null })), runs, runsUrl });
}

/** POST /start/<name> with an optional JSON body (the input) → { runId }. The router has checked the caller. */
export async function startRun(req: Request, workflows: Registry, name: string): Promise<Response> {
  const fn = workflow(workflows, name);
  const body = (await req.text()).trim();
  let args: unknown[] = [];
  try {
    if (body) args = [JSON.parse(body)];
  } catch {
    throw new HttpError(400, "The body must be JSON: the workflow's input");
  }
  return json({ runId: (await start(fn, args)).runId });
}

/** GET /runs/<id> → { runId, status, returnValue, error }, without waiting for the run to finish. */
export async function runStatus(id: string): Promise<Response> {
  if (!/^[\w-]{1,128}$/.test(id)) throw new HttpError(404, `No run ${id}`);
  const run = getRun<unknown>(id);
  const status = await run.status.catch((e: unknown) => {
    throw WorkflowRunNotFoundError.is(e) ? new HttpError(404, `No run ${id}`) : e;
  });
  let error: string | null = null;
  // Terminal, so returnValue settles on its first read; it also revives (and decrypts) the stored payload.
  const returnValue =
    status === "completed" || status === "failed"
      ? await run.returnValue.catch((e) => ((error = failure(e)), null))
      : null;
  return json({ runId: id, status, returnValue: returnValue ?? null, error });
}

/** GET /cron/<name> with `Authorization: Bearer $CRON_SECRET` → { runId }; the run gets no input. */
export async function cronRun(req: Request, workflows: Registry, name: string): Promise<Response> {
  const secret = value("CRON_SECRET");
  if (!secret) throw new HttpError(401, "CRON_SECRET is not set, so cron requests are refused");
  if (!safeEqual(req.headers.get("authorization"), `Bearer ${secret}`)) throw new HttpError(401, "Unauthorized");
  return json({ runId: (await start(workflow(workflows, name), [])).runId });
}
