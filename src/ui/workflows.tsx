"use client";
import { useEffect } from "react";
import { Pending, useApi } from "./load.js";
import { Table } from "./table.js";

type Run = { id: string; workflow: string; status: string; startedAt: string | null; createdAt: string; completedAt: string | null; durationMs: number | null; error: string | null };
type Workflows = { workflows: { name: string; schedule: string | null }[]; runs: Run[]; runsUrl: string | null };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const duration = (ms: number | null) =>
  ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`;

/** Workflows: the registry with schedules and the Workflow SDK's recent runs. Read-only; refreshes every 5 s while the tab is visible. */
export function WorkflowsView() {
  const { data, error, at, reload } = useApi<Workflows>("workflows");
  // One timer at a time, armed after each result, so a slow answer is never cut off; a hidden tab stops polling and
  // refreshes as soon as it is shown again.
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && reload();
    const timer = setTimeout(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", tick); };
  }, [at, reload]);
  if (!data) return <Pending error={error} />;
  return (
    <>
      {error && <p className="gtm-banner gtm-error">{error}</p>}
      <section>
        <h2 className="gtm-h">Workflows</h2>
        <Table columns={["Workflow", "Schedule"]} rows={data.workflows.map((w) => [w.name, w.schedule ? <code>{w.schedule}</code> : "—"])}
          empty="No workflows yet. Your agent adds them in workflows/index.ts." />
      </section>
      <section>
        <div className="gtm-head">
          <h2 className="gtm-h">Recent runs</h2>
          {data.runsUrl && <a href={data.runsUrl} target="_blank" rel="noreferrer">All runs on Vercel ↗</a>}
        </div>
        <Table
          columns={["Workflow", "Status", "Started", "Duration", "Error"]}
          rows={data.runs.map((r) => [
            r.workflow,
            <span className={`gtm-status gtm-s-${r.status}`} title={r.id}>{r.status}</span>,
            when(r.startedAt ?? r.createdAt),
            duration(r.durationMs),
            r.error ? <span className="gtm-error" title={r.error}>{r.error}</span> : "",
          ])}
          empty="No runs yet."
        />
      </section>
    </>
  );
}
