import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { gateway, jsonSchema, Output, stepCountIs, tool, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from "ai";
import { FatalError, sleep } from "workflow";
import { z } from "zod";
import { parseSkill, SKILL_NAME, SKILLS_DIR } from "../shared/skill.js";
import { runAgentCli, type CliBackend, type Reasoning, type Usage } from "./cli.js";
import { chooseBackend, sanitizeSchema, type Family } from "./models.js";
import { callMcpTool, fetchPage, listMcpTools, type McpServer } from "./tools.js";

export type { CliBackend, McpServer, Reasoning, ToolSet, Usage };
/** The AI SDK's tool(), for `tools.custom`, so workflow code never imports `ai` itself. */
export { tool };

/**
 * Agent stage: every AI call in a workflow, one-shot (no tools) or tool-using. Call agent() from workflow scope, never
 * inside a "use step" function; it makes its own steps. The backend is chosen per call from the environment:
 * hosted → AI Gateway; laptop → AI Gateway when AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set, else
 * ANTHROPIC_API_KEY / OPENAI_API_KEY, else the whole stage as one step through the signed-in `claude` or `codex`.
 * On the Gateway and key paths every model call and every tool call is its own step.
 */
export type AgentTools = {
  /** Hosted MCP servers by name (letters, digits, _ and -). Their tools are listed in a step per stage; each call is a step. */
  mcp?: Record<string, McpServer>;
  /** `search`: the Gateway's search, the provider's own on an API key, the CLI's own on a laptop. `fetch`: fetch_page (a step, public addresses only). */
  web?: { search?: boolean; fetch?: boolean };
  /** Your own tools; give each `execute` a "use step" function. They need AI Gateway or an API key. */
  custom?: ToolSet;
};

export type AgentOptions<T = string> = {
  /** Stable id shown in the trace; use the stage function's name. */
  name: string;
  instructions: string;
  prompt: string;
  /** Company skills by folder name: each `.agents/skills/<name>/SKILL.md` body (no front matter) is added to the instructions. */
  skills?: string[];
  /** The result the agent must return; plain text when omitted. Use nullable fields, not optional ones, and no string formats. */
  schema?: z.ZodType<T>;
  /**
   * A Gateway model id; defaults to GTM_MODEL, else the default that follows GTM_AGENT_BACKEND. On the CLI path it
   * (or GTM_MODEL) goes to `claude --model` / `codex -m` when it is that CLI's family; else the CLI's own default.
   */
  model?: string;
  reasoning?: Reasoning;
  tools?: AgentTools;
  /** Model calls, tool turns included. Default 20; when reached, one last call without tools writes up the result. Not on the CLI path. */
  maxSteps?: number;
  /**
   * Soft spend cap in USD. Gateway and API keys: after the call that reaches it (reported model cost plus tool
   * costs; API-key providers report no model cost), one last call without tools writes up the result. claude:
   * `--max-budget-usd`, which stops with no result, so the stage fails. codex reports no cost and has no cap.
   */
  maxUsd?: number;
  /** Wall-clock limit ("90s", "5m", "1h", or milliseconds). Default "10m"; the stage fails when it is reached. */
  timeout?: string | number;
};

export type AgentToolCall = { tool: string; input: unknown; ok: boolean; costUsd: number };

export type AgentResult<T = string> = {
  value: T;
  /** Gateway-reported model cost plus tool-reported cost; claude's reported cost on the CLI path; 0 where nothing reports one. */
  costUsd: number;
  modelCalls: number;
  toolCalls: AgentToolCall[];
  usage: Usage;
  /** Why the loop ended: it finished, or maxSteps / maxUsd cut it short and a last call wrote up the result. Always "done" on the CLI path. */
  stopReason: "done" | "maxSteps" | "maxUsd";
};

const WRAP_UP = "Stop using tools now. Return the requested result from what you have found so far; use null or empty lists for anything not established.";

/** Workflow scope. One agent stage: picks the backend, builds the tools, runs the loop, returns the parsed result. */
export async function agent<T = string>(o: AgentOptions<T>): Promise<AgentResult<T>> {
  const timeoutMs = durationMs(o.timeout ?? "10m");
  for (const n of Object.keys(o.tools?.mcp ?? {})) if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) throw new Error(`Agent ${o.name}: MCP server name ${n} must be letters, digits, _ or -`);
  for (const n of o.skills ?? []) if (!SKILL_NAME.test(n)) throw new Error(`Agent ${o.name}: skill ${JSON.stringify(n)} must be a folder name in ${SKILLS_DIR}`);
  const schema = o.schema ? (sanitizeSchema(z.toJSONSchema(o.schema)) as Record<string, unknown>) : undefined;
  const route = chooseBackend({ name: o.name, model: o.model, custom: Object.keys(o.tools?.custom ?? {}).length > 0 });
  const instructions = o.skills?.length ? [o.instructions, ...(await readSkills(o.skills))].join("\n\n") : o.instructions;
  const parse = (v: unknown, from: string) => {
    if (!o.schema) return v as T;
    const r = o.schema.safeParse(v);
    if (r.success) return r.data;
    throw new Error(`Agent ${o.name}: ${from}'s result does not match the schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  };
  if (route.kind === "cli") {
    const web = Boolean(o.tools?.web?.search || o.tools?.web?.fetch);
    const r = await runAgentCli({ backend: route.cli, instructions, prompt: o.prompt, schema, model: o.model, reasoning: o.reasoning, mcp: o.tools?.mcp, web, maxUsd: o.maxUsd, timeoutMs });
    return { ...r, costUsd: round(r.costUsd), value: parse(r.value, route.cli ?? "the CLI"), toolCalls: [], stopReason: "done" };
  }

  const spentUsd = (steps: StepResult<ToolSet>[]) => gatewayUsd(steps) + sum(traceToolCalls(steps), (c) => c.costUsd);
  const overBudget = (steps: StepResult<ToolSet>[]) => o.maxUsd != null && spentUsd(steps) >= o.maxUsd;
  // No maxRetries: model steps run with engine retries off (doStreamStep.maxRetries = 0), so the SDK's own 2 are the only ones.
  const loop = new WorkflowAgent({
    id: o.name,
    model: (route.kind === "gateway" ? route.model : new KeyModel(route.kind, route.id)) as LanguageModel,
    instructions,
    tools: await buildTools(o.tools, route.kind),
    ...(o.reasoning && { reasoning: o.reasoning }),
    stopWhen: [stepCountIs(o.maxSteps ?? 20), ({ steps }) => overBudget(steps as StepResult<ToolSet>[])],
  });
  const output = schema ? Output.object({ schema: jsonSchema<T>(schema as never) }) : Output.text();
  // A race against sleep(): workflow scope has no timers, so AbortSignal.timeout() cannot work here.
  const controller = new AbortController();
  const deadline = sleep(timeoutMs).then(() => "timeout" as const);
  const call = async (task: { prompt: string } | { messages: ModelMessage[]; toolChoice: "none" }) => {
    const r = await Promise.race([loop.stream({ ...task, output, abortSignal: controller.signal } as never), deadline]);
    if (r === "timeout") {
      controller.abort();
      throw new Error(`Agent ${o.name} timed out after ${o.timeout ?? "10m"}`);
    }
    const res = r as { steps: StepResult<ToolSet>[]; messages: ModelMessage[]; output?: unknown; error?: unknown };
    const empty = res.output == null || res.output === "";
    if (empty && "error" in res) throw res.error instanceof Error ? res.error : new Error(`Agent ${o.name}: ${JSON.stringify(res.error)}`);
    return { steps: res.steps, messages: res.messages, output: empty ? undefined : res.output };
  };

  const first = await call({ prompt: o.prompt });
  let { steps, output: result } = first;
  const stopReason = result !== undefined ? "done" : overBudget(steps) ? "maxUsd" : "maxSteps";
  if (result === undefined) {
    // maxSteps or maxUsd ended the loop mid-research: one last call, no tools, writes up what was found.
    // WorkflowAgent rejects system messages inside `messages`, so the instructions travel as the agent's own.
    const history = first.messages.filter((m) => m.role !== "system");
    const last = await call({ messages: [...history, { role: "user", content: WRAP_UP }], toolChoice: "none" });
    steps = [...steps, ...last.steps];
    result = last.output;
  }
  if (result === undefined) throw new Error(`Agent ${o.name} returned no result (${stopReason})`);
  const toolCalls = traceToolCalls(steps);
  return {
    value: parse(result, route.kind === "gateway" ? "AI Gateway" : route.kind),
    costUsd: round(spentUsd(steps)),
    modelCalls: steps.length,
    toolCalls,
    usage: { inputTokens: sum(steps, (s) => s.usage?.inputTokens ?? 0), outputTokens: sum(steps, (s) => s.usage?.outputTokens ?? 0) },
    stopReason,
  };
}

/** Step: each named skill's SKILL.md body, front matter dropped, from the project as deployed (withGtm traces .agents/skills). */
async function readSkills(names: string[]): Promise<string[]> {
  "use step";
  const [{ readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  return Promise.all(names.map(async (n) => {
    const text = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), SKILLS_DIR, n, "SKILL.md"), "utf8").catch(() => null);
    if (text == null) throw new FatalError(`No skill "${n}": agent() reads ${SKILLS_DIR}/${n}/SKILL.md, which does not exist`);
    return parseSkill(text).body.trim();
  }));
}

/**
 * An API-key model that crosses step boundaries as { family, modelId } only and is rebuilt inside each model step,
 * where the provider reads its key. A provider's own model object would serialize its headers, key included, into
 * the run's event log, and the app's step bundle does not register those classes.
 */
type V4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
class KeyModel {
  readonly specificationVersion = "v4";
  constructor(readonly family: Family, readonly modelId: string) {}
  static [Symbol.for("workflow-serialize")](m: KeyModel) { return { family: m.family, modelId: m.modelId }; }
  static [Symbol.for("workflow-deserialize")](d: { family: Family; modelId: string }) { return new KeyModel(d.family, d.modelId); }
  private real() { return (this.family === "anthropic" ? anthropic(this.modelId) : openai(this.modelId)) as V4; }
  get provider() { return this.real().provider; }
  get supportedUrls() { return this.real().supportedUrls; }
  doGenerate(options: Parameters<V4["doGenerate"]>[0]) { return this.real().doGenerate(options); }
  doStream(options: Parameters<V4["doStream"]>[0]) { return this.real().doStream(options); }
}

/** Workflow scope: built-in and MCP tools become step-backed tools; web search runs inside the model call. */
async function buildTools(t: AgentTools | undefined, kind: "gateway" | Family): Promise<ToolSet> {
  const tools: ToolSet = { ...t?.custom };
  if (t?.web?.fetch) {
    tools.fetch_page = tool({
      description: "Fetch a public web page and return its readable text, up to about 8,000 characters.",
      inputSchema: z.object({ url: z.string() }),
      execute: ({ url }) => fetchPage(url),
    });
  }
  if (t?.web?.search) tools.web_search = kind === "gateway" ? gateway.tools.exaSearch() : kind === "anthropic" ? anthropic.tools.webSearch_20250305() : openai.tools.webSearch();
  const servers = Object.entries(t?.mcp ?? {});
  const listed = await Promise.all(servers.map(([, s]) => listMcpTools(s)));
  servers.forEach(([server, config], i) => {
    for (const def of listed[i]) {
      const name = (def.name.startsWith(`${server}_`) ? def.name : `${server}_${def.name}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      tools[name] = tool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(sanitizeSchema(def.inputSchema) as never),
        strict: false,
        execute: (input) => callMcpTool(config, def.name, input),
      });
    }
  });
  return tools;
}

/** "90s", "5m", "1h", "2d", or a number of milliseconds. */
function durationMs(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i.exec(v);
  if (!m) throw new Error(`Not a duration: ${v}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "ms"];
}

/** The Gateway reports each call's cost in its provider metadata. */
function gatewayUsd(steps: StepResult<ToolSet>[]): number {
  return sum(steps, (s) => {
    const cost = (s.providerMetadata?.gateway as { cost?: unknown } | undefined)?.cost;
    return typeof cost === "string" || typeof cost === "number" ? Number(cost) || 0 : 0;
  });
}

/** Tool results may report their cost: `{ costUsd }` from our steps, `{ cost: { value, currency: "USD" } }` from a provider. */
function toolUsd(output: unknown): number {
  const r = (output ?? {}) as { costUsd?: unknown; cost?: { value?: unknown; currency?: unknown } };
  if (typeof r.costUsd === "number") return r.costUsd;
  return r.cost?.currency === "USD" && typeof r.cost.value === "number" ? r.cost.value : 0;
}

function traceToolCalls(steps: StepResult<ToolSet>[]): AgentToolCall[] {
  return steps.flatMap((s) => {
    const results = new Map((s.toolResults ?? []).map((r) => [r.toolCallId, r.output as unknown]));
    return (s.toolCalls ?? []).map((c) => {
      const out = results.get(c.toolCallId);
      const ok = results.has(c.toolCallId) && !(out && typeof out === "object" && (out as { isError?: unknown }).isError);
      return { tool: c.toolName, input: c.input, ok, costUsd: round(toolUsd(out)) };
    });
  });
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const sum = <T>(items: T[], f: (item: T) => number) => items.reduce((n, item) => n + f(item), 0);
