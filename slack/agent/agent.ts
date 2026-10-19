import { defineAgent } from "eve";

/** The Slack agent's model, called through AI Gateway (hosted, eve authenticates with the deployment's Vercel OIDC). */
export default defineAgent({ model: "anthropic/claude-sonnet-5.5" });
