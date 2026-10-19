// The workflow registry: { <name>: workflowFn }. The cockpit, `gtm run` and crons find workflows only here.
export const workflows = {} satisfies Record<string, (...args: any[]) => Promise<unknown>>;
