import { defineTool } from "eve/tools";
import { z } from "zod";
import { gtmApi } from "../lib/app";

interface Run {
  status?: string;
}

/** Reads a run, waiting up to ~90 seconds for it to finish so a preview's result comes back in one call. */
export default defineTool({
  description:
    "Read a workflow run: { runId, status, returnValue, error }. Waits up to 90 seconds while it is pending or running. A preview's sample rows and measured cost are in its returnValue.",
  inputSchema: z.object({ runId: z.string().min(1) }),
  label: { start: () => "Check the run" },
  async execute({ runId }) {
    const until = Date.now() + 90_000;
    for (;;) {
      const run = (await gtmApi(`/runs/${encodeURIComponent(runId)}`)) as Run;
      if ((run.status !== "pending" && run.status !== "running") || Date.now() > until) return run;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  },
});
