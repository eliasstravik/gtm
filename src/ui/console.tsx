"use client";
import { notFound } from "next/navigation.js";
import { Suspense } from "react";
import { ConnectionsView } from "./connections.js";
import { ContextView } from "./context.js";
import { DataView } from "./data.js";
import { RunsView, WorkflowView, WorkflowsView } from "./workflows.js";

/**
 * The Console's views by path: `[]` or `["context"]` Context, `["workflows"]` the workflows, `["workflows", name]` one
 * workflow's runs, `["runs"]` every run, `["data"]` and `["connections"]`. Any other path is a 404.
 */
export function Console({ path = [] }: { path?: string[] }) {
  const [view = "context", arg, ...rest] = path;
  const page =
    rest.length ? null
    : view === "workflows" ? (arg ? <WorkflowView name={arg} /> : <WorkflowsView />)
    : arg ? null
    : view === "context" ? <ContextView />
    : view === "runs" ? <RunsView />
    : view === "data" ? <DataView />
    : view === "connections" ? <ConnectionsView />
    : null;
  if (!page) notFound();
  // Suspense because the views read the query string, which is only known in the browser on static pages.
  return <Suspense>{page}</Suspense>;
}
