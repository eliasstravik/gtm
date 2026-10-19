/** Workflows view, start, runs and cron (plan §3, §4), all through the Workflow SDK; never the database. */
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { parseWorkflowName } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import { environment, isHosted, safeEqual, value } from "../shared/env.js";
import { cronSchedules } from "../shared/scan.js";
import { HttpError, json } from "./http.js";

type WorkflowFn = (...args: any[]) => Promise<unknown>;
/** One box of a workflow's diagram: a business step in plain words, not code. */
export type DiagramNode = { id: string; label: string; kind?: "input" | "action" | "decision" | "output"; explanation?: string; details?: Record<string, string | undefined> };
/** What the Console shows about a workflow, written by the agent next to it. It never changes how the workflow runs. */
export type About = {
  description?: string; tables?: string[]; connections?: string[];
  diagram?: { nodes: DiagramNode[]; edges: { source: string; target: string; label?: string }[] };
};
/** The registry `workflows/index.ts` exports: name → workflow function, or `{ run: workflowFn, ...About }`. */
export type Registry = Record<string, WorkflowFn | ({ run: WorkflowFn } & About)>;
const runOf = (e: Registry[string] | undefined) => (typeof e === "function" ? e : e?.run);

type World = Awaited<ReturnType<typeof getWorld>>;
type RunRow = { runId: string; status: string; workflowName: string; errorCode?: string | null; createdAt: Date;
  startedAt?: Date | null; completedAt?: Date | null };

function workflow(workflows: Registry, name: string) {
  const fn = Object.hasOwn(workflows, name) ? runOf(workflows[name]) : undefined;
  if (typeof fn !== "function") throw new HttpError(404, `No workflow named "${name}" in workflows/index.ts`);
  return fn;
}

/** Workflow name → schedule: vercel.json crons on /api/gtm/cron/<name> unless hosted, then GTM_CRONS from withGtm. */
function schedules(): Map<string, string> {
  // process.env.GTM_CRONS literally, so the value withGtm inlines at build time is the one read.
  const crons: ReturnType<typeof cronSchedules> = isHosted() ? JSON.parse(process.env.GTM_CRONS ?? "[]") : cronSchedules();
  const map = new Map<string, string>();
  for (const { workflow: w, schedule } of crons) map.set(w, map.has(w) ? `${map.get(w)}; ${schedule}` : schedule);
  return map;
}

type List = { pagination: { limit: number; sortOrder: "desc"; cursor?: string }; workflowName?: string; status?: string;
  startTime?: string; endTime?: string };
type Page = { data: RunRow[]; cursor: string | null; hasMore: boolean };

/** One page of runs, newest first: world.analytics.runs.list() where the world has it (Vercel), else world.runs.list(). */
async function listRuns(world: World, params: List): Promise<Page> {
  if (world.analytics) {
    try {
      return await world.analytics.runs.list(params as never);
    } catch (error) {
      console.error("[gtm] world.analytics.runs.list failed; trying world.runs.list", error);
    }
  }
  const { startTime, endTime, ...rest } = params;
  const page = await world.runs.list({ ...rest, resolveData: "none" } as never);
  // The local world has no time window: the page is narrowed here instead.
  return startTime ? { ...page, data: page.data.filter((r) => new Date(r.createdAt).toISOString() >= startTime) } : page;
}

/** A failed run's message (the cause WorkflowRunFailedError wraps). */
const failure = (e: { cause?: { message?: unknown }; message?: string }) =>
  typeof e?.cause?.message === "string" ? e.cause.message : (e?.message ?? String(e));

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Best effort: deployments know neither team nor project slug, so Vercel's own deep link asks for them. */
const vercelUrl = (path: string, title: string) =>
  isHosted() ? `https://vercel.com/d?to=${encodeURIComponent(`/[team]/[project]/workflows${path}?environment=${environment()}`)}&title=${title}` : null;

/** workflowId (what runs record as workflowName; the SWC transform sets it on each function) ↔ registry name. */
function ids(workflows: Registry) {
  const byId = new Map(Object.entries(workflows).map(([name, e]) => [(runOf(e) as { workflowId?: string }).workflowId ?? name, name]));
  const name = (id: string) => byId.get(id) ?? parseWorkflowName(id)?.shortName ?? id;
  return { name, id: (n: string) => [...byId].find(([, v]) => v === n)?.[0] };
}

/**
 * GET /workflows → { workflows: [{ name, schedule, lastRun, ...About }], runsKnown, runsUrl }; lastRun from the newest
 * 100 runs, else null.
 */
export async function workflowsList(workflows: Registry): Promise<Response> {
  const crons = schedules(), { name } = ids(workflows);
  const page = await getWorld().then((w) => listRuns(w, { pagination: { limit: 100, sortOrder: "desc" } })).catch((error) => {
    console.error("[gtm] could not list workflow runs", error);
    return null;
  });
  const last = new Map<string, RunRow>();
  for (const r of page?.data ?? []) if (!last.has(name(r.workflowName))) last.set(name(r.workflowName), r);
  const lastRun = (n: string) => {
    const r = last.get(n);
    return r ? { id: r.runId, status: r.status, createdAt: iso(r.createdAt), startedAt: iso(r.startedAt), completedAt: iso(r.completedAt) } : null;
  };
  return json({
    workflows: Object.entries(workflows).map(([n, e]) => {
      const { run: _, ...about } = typeof e === "function" ? { run: e } : e;
      return { name: n, schedule: crons.get(n) ?? null, lastRun: lastRun(n), ...about };
    }),
    runsKnown: page != null, runsUrl: vercelUrl("", "Workflow+runs"),
  });
}

const PERIODS: Record<string, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

/**
 * GET /workflows/runs?workflow=&status=&period=day|week|month&q=&cursor= → { data, cursor, hasMore, runsUrl }: 50 runs
 * a page, newest first. `q` narrows that page by run id or workflow name, so a page can come back empty with more after it.
 */
export async function runsList(workflows: Registry, p: URLSearchParams): Promise<Response> {
  const { name, id } = ids(workflows);
  const workflow = p.get("workflow"), status = p.get("status"), period = PERIODS[p.get("period") ?? ""], q = p.get("q")?.toLowerCase();
  if (status && !["pending", "running", "completed", "failed", "cancelled"].includes(status)) throw new HttpError(400, "Unknown status");
  const now = Date.now();
  const page = await listRuns(await getWorld(), {
    pagination: { limit: 50, sortOrder: "desc", ...(p.get("cursor") && { cursor: p.get("cursor")! }) },
    ...(workflow && { workflowName: id(workflow) ?? workflow }), ...(status && { status }),
    ...(period && { startTime: new Date(now - period).toISOString(), endTime: new Date(now).toISOString() }),
  });
  const rows = page.data.filter((r) => !q || `${r.runId} ${name(r.workflowName)}`.toLowerCase().includes(q));
  // List rows carry only an error code. The 10 newest failures get their message: one run read each, and reading
  // returnValue also decompresses and decrypts the stored error.
  const failed = rows.filter((r) => r.status === "failed").slice(0, 10);
  const errors = new Map(await Promise.all(failed.map(async (r) => [r.runId, await getRun(r.runId).returnValue.then(() => null, failure)] as const)));
  const data = rows.map((r) => ({
    id: r.runId, workflow: name(r.workflowName), status: r.status,
    createdAt: iso(r.createdAt), startedAt: iso(r.startedAt), completedAt: iso(r.completedAt),
    error: r.status === "failed" ? (errors.get(r.runId) ?? r.errorCode ?? "failed") : null,
    url: vercelUrl(`/runs/${encodeURIComponent(r.runId)}`, "Workflow+run"),
  }));
  return json({ data, cursor: page.cursor, hasMore: page.hasMore, runsUrl: vercelUrl("", "Workflow+runs") });
}

/** POST /start/<name> with an optional JSON body (the input) → { runId }. The router has checked the caller. */
export async function startRun(req: Request, workflows: Registry, name: string): Promise<Response> {
  const fn = workflow(workflows, name);
  const body = (await req.text()).trim();
  let args: unknown[];
  try { args = body ? [JSON.parse(body)] : []; }
  catch { throw new HttpError(400, "The body must be JSON: the workflow's input"); }
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
  const terminal = status === "completed" || status === "failed";
  const returnValue = terminal ? await run.returnValue.catch((e) => ((error = failure(e)), null)) : null;
  return json({ runId: id, status, returnValue: returnValue ?? null, error });
}

/** GET /cron/<name> with `Authorization: Bearer $CRON_SECRET` → { runId }; the run gets no input. */
export async function cronRun(req: Request, workflows: Registry, name: string): Promise<Response> {
  const secret = value("CRON_SECRET");
  if (!secret) throw new HttpError(401, "CRON_SECRET is not set, so cron requests are refused");
  if (!safeEqual(req.headers.get("authorization"), `Bearer ${secret}`)) throw new HttpError(401, "Unauthorized");
  return json({ runId: (await start(workflow(workflows, name), [])).runId });
}
