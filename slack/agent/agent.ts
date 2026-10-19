import { defineAgent } from "eve";

/**
 * The Slack agent's model, called through AI Gateway (hosted, eve authenticates with the deployment's Vercel OIDC).
 * Its context window (AI Gateway's figure) is given here, so eve does not fetch it from AI Gateway every time
 * `gtm dev` starts: the agent then also starts offline. Change both together.
 */
export default defineAgent({ model: "anthropic/claude-sonnet-5.5", modelContextWindowTokens: 1_000_000 });
