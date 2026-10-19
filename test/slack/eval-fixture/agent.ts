import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const push = {
  command: 'gh-signed-commit --repo acme/gtm-acme --branch main -m "Add the mid-market ICP"',
  description: "Add the mid-market ICP",
  permissions: [{ provider: "github", repositories: ["acme/gtm-acme"], access: "write" }],
};
const preview = { workflow: "enrich", input: { limit: 5 }, summary: "Preview of 5 rows, about $0.04." };

// Eval fixture: a scripted model that calls github (when asked to push) or start_run, then reports the tool result.
export default defineAgent({
  model: mockModel(({ toolResults, lastUserMessage }) =>
    toolResults.length > 0
      ? `Result: ${JSON.stringify(toolResults[0]?.output)}`
      : { toolCalls: [String(lastUserMessage).includes("push") ? { name: "github", input: push } : { name: "start_run", input: preview }] }),
});
