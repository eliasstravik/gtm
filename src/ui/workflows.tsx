"use client";
import "./workflows.css";

/** Workflows: the registry, each with a dot for its last run. (Stub until the Workflows helper fills it in.) */
export function WorkflowsView() {
  return <p className="notice">Workflows</p>;
}

/** One workflow: its schedule and its runs. */
export function WorkflowView({ name }: { name: string }) {
  return <p className="notice">{name}</p>;
}

/** Every run, or one workflow's, with filters and paging. */
export function RunsView({ workflow }: { workflow?: string }) {
  return <p className="notice">Runs {workflow}</p>;
}
