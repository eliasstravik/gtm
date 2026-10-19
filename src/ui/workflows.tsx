"use client";
import { useEffect, useState } from "react";
import type { About } from "../api/runs.js";
import { ConnectionsView } from "./connections.js";
import { DataView } from "./data.js";
import { DiagramView } from "./diagram.js";
import { Link, Search, Status, duration, time, useApi, useQuery } from "./load.js";
import "./workflows.css";

type LastRun = { id: string; status: string; createdAt: string; startedAt: string | null; completedAt: string | null };
type Workflow = { name: string; schedule: string | null; lastRun: LastRun | null } & About;
type Workflows = { workflows: Workflow[]; runsKnown: boolean; runsUrl: string | null };
type Run = LastRun & { workflow: string; error: string | null; url: string | null };
type Runs = { data: Run[]; cursor: string | null; hasMore: boolean; runsUrl: string | null };

const active = (run?: { status: string } | null) => run?.status === "pending" || run?.status === "running";
const STATUSES = ["pending", "running", "completed", "failed", "cancelled"];
const WORDS: Record<string, string> = { pending: "queued" };

function ago(value: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000), minutes = Math.round(seconds / 60);
  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A Vercel Cron expression (UTC) in words when it is a plain daily or weekly time; otherwise the expression itself. */
function cronText(cron: string) {
  const [minute, hour, day, month, weekday, ...rest] = cron.trim().split(/\s+/);
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC` : undefined;
  if (!rest.length && at && day === "*" && month === "*") {
    if (weekday === "*") return `Daily ${at}`;
    if (/^[0-6]$/.test(weekday)) return `${DAYS[Number(weekday)]} ${at}`;
    if (weekday === "1-5") return `Weekdays ${at}`;
  }
  return `Cron ${cron}`;
}
/** The API joins a workflow's crons with "; ". */
const scheduleText = (schedule: string | null) => schedule?.split("; ").map(cronText).join(" · ");

/** The last run's status as a dot before the name; its time is in the tooltip, the history on the workflow's page. */
function Dot({ run, known }: { run: LastRun | null; known: boolean }) {
  const label = run ? `Last run ${WORDS[run.status] ?? run.status} ${ago(run.createdAt)}` : known ? "No recent run" : "";
  return <span className={`wf-dot wf-dot-${run?.status ?? (known ? "never" : "unknown")}`} role={label ? "img" : undefined}
    aria-label={label || undefined} title={label || undefined} />;
}

/** Workflows: the registry, one line each with a dot for its last run. Polls faster while a last run is still going. */
export function WorkflowsView() {
  const state = useApi<Workflows>("workflows", (d) => (d.workflows.some((w) => active(w.lastRun)) ? 5000 : 30_000));
  const { params, href, go } = useQuery();
  const search = params.get("q") ?? "", failingOnly = params.get("filter") === "failing";
  const all = state.data?.workflows ?? [], known = state.data?.runsKnown ?? false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((w) => (!failingOnly || w.lastRun?.status === "failed") && words.every((word) => w.name.toLowerCase().includes(word)));
  // "/" jumps to the search, as on most list pages; typing in a field is left alone.
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const input = document.querySelector<HTMLInputElement>(".wf-controls input[type=search]");
      if (input) { e.preventDefault(); input.focus(); }
    };
    addEventListener("keydown", focus);
    return () => removeEventListener("keydown", focus);
  }, []);
  return <>
    <div className="title-row wf-title">
      <h1>Workflows</h1>
      {all.length > 0 && <div className="wf-controls">
        <Search label="Search workflows" value={search} onChange={(q) => go({ q: q || undefined }, true)} />
        <button type="button" className="wf-failing" aria-pressed={failingOnly} onClick={() => go({ filter: failingOnly ? undefined : "failing" }, true)}>
          Failing{known && <span className="wf-failing-count">{all.filter((w) => w.lastRun?.status === "failed").length}</span>}
        </button>
      </div>}
    </div>
    <div className="page">
      <Status state={state} />
      {state.data && (shown.length ? <ul role="list" className="wf-rows" aria-label="Workflows">
        {shown.map((w) => <li key={w.name} className="wf-row">
          <Dot run={w.lastRun} known={known} />
          <Link className="wf-link" href={`/workflows/${encodeURIComponent(w.name)}`}>{w.name}</Link>
          {w.schedule && <span className="wf-meta">{scheduleText(w.schedule)}</span>}
        </li>)}
      </ul> : <p className="notice">
        {all.length ? "No matching workflows. " : <>No workflows yet. Your agent adds them in <code>workflows/index.ts</code>.</>}
        {all.length > 0 && <button type="button" onClick={() => go({ q: undefined, filter: undefined }, true)}>Show all</button>}
      </p>)}
    </div>
  </>;
}

const TABS = [["diagram", "Diagram"], ["runs", "Runs"], ["data", "Data"], ["connections", "Connections"]];

/**
 * One workflow, in the viewer's four tabs (`?view=`): its diagram with what it does and how it starts, its runs, its
 * tables and the keys it uses. It opens on the diagram, or on Runs when it has none. The path arrives still encoded.
 */
export function WorkflowView({ name: segment }: { name: string }) {
  let name = segment;
  try { name = decodeURIComponent(segment); } catch {}
  const state = useApi<Workflows>("workflows"), { params } = useQuery();
  const w = state.data?.workflows.find((x) => x.name === name);
  const keys = useApi<{ connections: { name: string; set: boolean }[] }>(w?.connections?.length ? "connections" : null).data;
  const unset = keys?.connections.filter((c) => !c.set && w?.connections?.includes(c.name)).length ?? 0;
  const view = params.get("view") ?? (w?.diagram ? "diagram" : "runs");
  return <>
    <div className="title-row">
      <div className="breadcrumbs"><Link href="/workflows">Workflows</Link><span aria-hidden="true">/</span><h1>{name}</h1></div>
    </div>
    <Status state={state} />
    {state.data && !w && <p role="alert" className="notice">This workflow no longer exists. <Link href="/workflows">Show all workflows</Link></p>}
    {w && <>
      <nav className="tabs" aria-label="Workflow views">
        {TABS.map(([v, label]) => <Link key={v} href={`/workflows/${encodeURIComponent(name)}?view=${v}`} aria-current={view === v ? "page" : undefined}>
          {label}{v === "connections" && unset > 0 && <span className="tab-count" title={`${unset} not set here`}>
            <span className="sr-only">, </span>{unset}<span className="sr-only"> not set</span></span>}
        </Link>)}
      </nav>
      {view === "runs" ? <RunsView workflow={name} />
        : view === "data" ? <DataView tables={w.tables ?? []} />
        : view === "connections" ? <ConnectionsView only={w.connections ?? null} />
        : <DiagramView diagram={w.diagram} summary={<>
          {w.description && <p className="diagram-description">{w.description}</p>}
          <p className="diagram-trigger">Starts: {scheduleText(w.schedule) ?? "Manual"}</p>
        </>} />}
    </>}
  </>;
}

/** How long a run took, or has taken so far: ticks every second while it runs. */
function Duration({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());
  const going = active(run);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => document.hidden || setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [going]);
  if (!run.startedAt || (!run.completedAt && !going)) return <>—</>;
  return <>{duration((run.completedAt ? new Date(run.completedAt).getTime() : now) - new Date(run.startedAt).getTime())}</>;
}

/** Every run, or one workflow's, newest first, 50 a page. Polls every 3 s while a shown run is still going. */
export function RunsView({ workflow }: { workflow?: string }) {
  const { params: p, href, go } = useQuery();
  const query = new URLSearchParams();
  for (const k of ["workflow", "q", "status", "period", "cursor"]) {
    const v = k === "workflow" ? (workflow ?? p.get(k)) : workflow && k === "q" ? null : p.get(k);
    if (v) query.set(k, v);
  }
  const state = useApi<Runs>(`workflows/runs?${query}`, (d) => (d.data.some(active) ? 3000 : 15_000));
  const names = useApi<Workflows>(workflow ? null : "workflows").data?.workflows ?? [];
  const d = state.data, filter = (k: string, v: string) => go({ [k]: v || undefined, cursor: undefined });
  const narrowed = ["q", "status", "period", "cursor", ...(workflow ? [] : ["workflow"])].some((k) => query.has(k));
  return <>
    {!workflow && <div className="title-row"><h1>Runs</h1></div>}
    <section className="pane runs" aria-label="Runs">
      <div className="toolbar">
        {!workflow && <>
          <select name="workflow" aria-label="Filter runs by workflow" value={p.get("workflow") ?? ""} onChange={(e) => filter("workflow", e.target.value)}>
            <option value="">All workflows</option>
            {names.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </select>
          <Search label="Search runs" value={p.get("q") ?? ""} onChange={(q) => go({ q: q || undefined, cursor: undefined }, true)} />
        </>}
        <select name="status" aria-label="Filter runs by status" value={p.get("status") ?? ""} onChange={(e) => filter("status", e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select name="period" aria-label="Filter runs by time" value={p.get("period") ?? ""} onChange={(e) => filter("period", e.target.value)}>
          <option value="">All time</option>
          <option value="day">Past day</option>
          <option value="week">Past week</option>
          <option value="month">Past month</option>
        </select>
        <button type="button" onClick={state.reload}>Refresh</button>
        {d?.runsUrl && <a className="button" href={d.runsUrl} target="_blank" rel="noopener noreferrer">Open in Vercel ↗</a>}
      </div>
      <Status state={state} />
      {d && <>
        <div className="table-scroll">
          <table>
            <thead><tr>{!workflow && <th>Workflow</th>}<th>Started</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead>
            <tbody>
              {d.data.map((r) => <tr key={r.id}>
                {!workflow && <td><Link href={`/workflows/${encodeURIComponent(r.workflow)}`}>{r.workflow}</Link><div className="muted">{r.id}</div></td>}
                <td>
                  <time tabIndex={0} dateTime={r.startedAt ?? r.createdAt} title={new Date(r.startedAt ?? r.createdAt).toString()}>{time(r.startedAt ?? r.createdAt)}</time>
                  {!r.startedAt && <span className="muted"> · Created</span>}
                </td>
                <td><span className={`status status-${r.status}`}>{r.status}</span></td>
                <td className="numeric"><Duration run={r} /></td>
                <td>
                  {r.error && <span className="run-error error" title={r.error}>{r.error}</span>}
                  {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer">Open in Vercel ↗</a>}
                  {!r.error && !r.url && <span className="muted">—</span>}
                </td>
              </tr>)}
            </tbody>
          </table>
          {!d.data.length && <p className="notice">
            {d.hasMore ? "No matching runs on these pages. Continue to older runs." : narrowed ? "No matching runs." : "No runs yet."}
          </p>}
        </div>
        <nav className="pagination" aria-label="Run pages">
          {p.has("cursor") && <Link href={href({ cursor: undefined })}>Newest</Link>}
          {d.hasMore && d.cursor && <Link href={href({ cursor: d.cursor })}>Older runs</Link>}
        </nav>
      </>}
    </section>
  </>;
}
