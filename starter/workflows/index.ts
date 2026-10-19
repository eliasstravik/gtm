// The workflow registry: { <name>: workflowFn }. The Console, `gtm run` and crons find workflows only here.
export const workflows = {} satisfies Record<string, (...args: any[]) => Promise<unknown>>;
