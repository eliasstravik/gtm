import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gtmApi } from "../lib/app";
import { requesterOnly } from "../lib/approval";

/** Models sometimes send the input as JSON text; the workflow needs the object itself. */
const asObject = (v: unknown) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** Starts a registered workflow, after the person who asked approves this exact call. */
export default defineTool({
  description:
    "Start a run of a workflow registered in workflows/index.ts, with optional JSON input (a preview uses the workflow's preview input). Every call asks the person who asked you to approve it first; put what the run does, how many rows and the cost quote in `summary`. Returns { runId }; read the result with get_run.",
  inputSchema: z.object({
    workflow: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    input: z.preprocess(asObject, z.record(z.string(), z.unknown())).optional()
      .describe('The run\'s input as a JSON object, e.g. {"company": "Acme"}; omit it for none.'),
    summary: z.string().min(1),
  }),
  approval: {
    request: always(),
    response: requesterOnly,
    prompt: ({ input }) => `Start ${input.workflow}? ${input.summary}`,
  },
  label: { start: ({ workflow }) => `Start ${workflow}` },
  async execute({ workflow, input }) {
    const body = input === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(asObject(input)) };
    return gtmApi(`/start/${workflow}`, { method: "POST", ...body });
  },
});
