"use client";
import { Suspense, type ComponentType } from "react";
import { ConnectionsView } from "./connections.js";
import { ContextView } from "./context.js";
import { DataView } from "./data.js";
import { WorkflowsView } from "./workflows.js";

const VIEWS: Record<string, ComponentType> = { context: ContextView, workflows: WorkflowsView, data: DataView, connections: ConnectionsView };

/** The four built-in views: `[]` or `["context"]` is Context, then `["workflows"]`, `["data"]`, `["connections"]`. */
export function Cockpit({ path = [] }: { path?: string[] }) {
  const View = Object.hasOwn(VIEWS, path[0] ?? "context") ? VIEWS[path[0] ?? "context"] : undefined;
  // Suspense because the views read the query string (?file=, ?table=), which is only known in the browser on static pages.
  return <Suspense>{View ? <View /> : <p className="gtm-muted">Not found.</p>}</Suspense>;
}
