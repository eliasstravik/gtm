// The workflow registry: { <name>: workflowFn } or { <name>: { run, description, tables, connections, diagram, approval,
// budget, schedule } }. The console, `gtm run` and crons find workflows only here (`npx gtm docs workflows`).
import type { Registry } from "@eliasstravik/gtm";

export const workflows = {} satisfies Registry;
