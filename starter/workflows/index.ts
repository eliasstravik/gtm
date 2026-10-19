// The workflow registry: { <name>: workflowFn } or { <name>: { run: workflowFn, description, tables, connections, diagram } }.
// The Console, `gtm run` and crons find workflows only here (`npx @eliasstravik/gtm docs workflows`).
import type { Registry } from "@eliasstravik/gtm/api";

export const workflows = {} satisfies Registry;
