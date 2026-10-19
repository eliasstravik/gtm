import { value } from "../shared/env.js";

/**
 * The one place that names models. The default follows the family the person runs locally (GTM_AGENT_BACKEND),
 * so a hosted copy stays with it: claude -> the newest Claude Haiku, anything else -> GPT-6 Luna. GTM_MODEL (or
 * `model` on a stage) always wins and is a Gateway id ("anthropic/claude-sonnet-5.5").
 * Checked 2026-10-19 against https://ai-gateway.vercel.sh/v1/models and the providers' model lists.
 */
export const MODELS = {
  claude: { gateway: "anthropic/claude-haiku-5.5", provider: "claude-haiku-5-5", family: "anthropic" },
  codex: { gateway: "openai/gpt-6-luna", provider: "gpt-6-luna", family: "openai" },
} as const;

export type Family = "anthropic" | "openai";
export type Default = keyof typeof MODELS;

/** The default for GTM_AGENT_BACKEND: claude, else codex (GPT-6 Luna). */
export function preferred(): Default {
  return value("GTM_AGENT_BACKEND")?.trim().toLowerCase() === "claude" ? "claude" : "codex";
}

/** The Gateway model for a stage: its own `model`, else GTM_MODEL, else the default that follows GTM_AGENT_BACKEND. */
export function gatewayModel(model?: string): string {
  return model?.trim() || value("GTM_MODEL")?.trim() || MODELS[preferred()].gateway;
}

/** A Gateway id as its own provider names it: "anthropic/claude-sonnet-5.5" -> anthropic "claude-sonnet-5-5". */
export function providerModel(gatewayId: string): { family: Family; id: string } {
  const known = Object.values(MODELS).find((m) => m.gateway === gatewayId);
  if (known) return { family: known.family, id: known.provider };
  const [family, id] = gatewayId.includes("/") ? gatewayId.split("/", 2) : [/^claude/.test(gatewayId) ? "anthropic" : "openai", gatewayId];
  if (family !== "anthropic" && family !== "openai") throw new Error(`${gatewayId} runs only through AI Gateway; set AI_GATEWAY_API_KEY or run \`vercel env pull\``);
  return { family, id: family === "anthropic" ? id.replace(/\./g, "-") : id };
}
