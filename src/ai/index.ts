import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { gateway, jsonSchema, Output, stepCountIs, tool, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from "ai";
import { sleep } from "workflow";
import { z } from "zod";
import { isHosted, value } from "../shared/env.js";
import { jwtClaims } from "../shared/request.js";
import { runAgentCli, type CliBackend, type Reasoning, type Usage } from "./cli.js";
import { gatewayModel, MODELS, preferred, providerModel, type Family } from "./models.js";
import { callMcpTool, fetchPage, listMcpTools, type McpServer } from "./tools.js";

export type { CliBackend, McpServer, Reasoning, Usage };

/**
 * Agent stage: a durable, tool-using agent inside a workflow. Call agent() from workflow scope, never inside a
 * "use step" function; it makes its own steps. The backend is chosen per call from the environment:
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
  /** The result the agent must return; plain text when omitted. Use nullable fields, not optional ones, and no string formats. */
  schema?: z.ZodType<T>;
  /** A Gateway model id; defaults to GTM_MODEL, else the default that follows GTM_AGENT_BACKEND. Ignored on the CLI path. */
  model?: string;
  reasoning?: Reasoning;
  tools?: AgentTools;
  /** Model calls, tool turns included. Default 20; when reached, one last call without tools writes up the result. */
  maxSteps?: number;
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
};

type Route = { kind: "gateway"; model: string } | { kind: Family; model: KeyModel } | { kind: "cli"; cli?: CliBackend };

const WRAP_UP = "Stop using tools now. Return the requested result from what you have found so far; use null or empty lists for anything not established.";
const NEEDS_API =
  "custom tools need AI Gateway or an API key: set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local, or run `vercel env pull` for VERCEL_OIDC_TOKEN";

/** Workflow scope. One agent stage: picks the backend, builds the tools, runs the loop, returns the parsed result. */
export async function agent<T = string>(o: AgentOptions<T>): Promise<AgentResult<T>> {
  const timeoutMs = durationMs(o.timeout ?? "10m");
  for (const n of Object.keys(o.tools?.mcp ?? {})) if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) throw new Error(`Agent ${o.name}: MCP server name ${n} must be letters, digits, _ or -`);
  const schema = o.schema ? (sanitizeSchema(z.toJSONSchema(o.schema)) as Record<string, unknown>) : undefined;
  const route = chooseBackend(o);
  if (route.kind === "cli") {
    const web = Boolean(o.tools?.web?.search || o.tools?.web?.fetch);
    const r = await runAgentCli({ backend: route.cli, instructions: o.instructions, prompt: o.prompt, schema, reasoning: o.reasoning, mcp: o.tools?.mcp, web, timeoutMs });
    return { ...r, costUsd: round(r.costUsd), value: (o.schema ? o.schema.parse(r.value) : r.value) as T, toolCalls: [] };
  }

  const loop = new WorkflowAgent({
    id: o.name,
    model: route.model as LanguageModel,
    instructions: o.instructions,
    tools: await buildTools(o.tools, route.kind),
    ...(o.reasoning && { reasoning: o.reasoning }),
    stopWhen: stepCountIs(o.maxSteps ?? 20),
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
  if (result === undefined) {
    // maxSteps ended the loop mid-research: one last call, no tools, writes up what was found. WorkflowAgent
    // rejects system messages inside `messages`, so the instructions travel as the agent's own.
    const history = first.messages.filter((m) => m.role !== "system");
    const last = await call({ messages: [...history, { role: "user", content: WRAP_UP }], toolChoice: "none" });
    steps = [...steps, ...last.steps];
    result = last.output;
  }
  if (result === undefined) throw new Error(`Agent ${o.name} returned no result`);
  const toolCalls = traceToolCalls(steps);
  return {
    value: (o.schema ? o.schema.parse(result) : result) as T,
    costUsd: round(gatewayUsd(steps) + sum(toolCalls, (c) => c.costUsd)),
    modelCalls: steps.length,
    toolCalls,
    usage: { inputTokens: sum(steps, (s) => s.usage?.inputTokens ?? 0), outputTokens: sum(steps, (s) => s.usage?.outputTokens ?? 0) },
  };
}

/** Workflow scope, in the plan's order: hosted Gateway; laptop Gateway; laptop API key; laptop CLI. */
function chooseBackend(o: AgentOptions<unknown>): Route {
  if (isHosted() || value("AI_GATEWAY_API_KEY")) return { kind: "gateway", model: gatewayModel(o.model) };
  const oidc = value("VERCEL_OIDC_TOKEN");
  if (oidc) {
    const { exp } = jwtClaims(oidc);
    if (typeof exp === "number" && exp * 1000 <= Date.now()) throw new Error("VERCEL_OIDC_TOKEN has expired; run `vercel env pull` again");
    return { kind: "gateway", model: gatewayModel(o.model) };
  }
  const keys = { anthropic: value("ANTHROPIC_API_KEY"), openai: value("OPENAI_API_KEY") };
  if (keys.anthropic || keys.openai) {
    const named = o.model?.trim() || value("GTM_MODEL")?.trim();
    if (named) {
      const { family, id } = providerModel(named);
      if (!keys[family]) throw new Error(`Agent ${o.name}: ${named} needs ${family === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} (or AI_GATEWAY_API_KEY)`);
      return { kind: family, model: new KeyModel(family, id) };
    }
    const first = MODELS[preferred()];
    const pick = keys[first.family] ? first : Object.values(MODELS).find((m) => keys[m.family])!;
    return { kind: pick.family, model: new KeyModel(pick.family, pick.provider) };
  }
  if (Object.keys(o.tools?.custom ?? {}).length) throw new Error(`Agent ${o.name}: ${NEEDS_API}`);
  const wanted = value("GTM_AGENT_BACKEND")?.trim().toLowerCase();
  return { kind: "cli", cli: wanted === "claude" || wanted === "codex" ? wanted : undefined };
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

/** OpenAI's strict JSON schema rejects string formats, and `claude --json-schema` the $schema key; the model reads the description instead. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "format") continue;
    const map = k === "properties" || k === "definitions" || k === "$defs";
    out[k] = map && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([p, x]) => [p, sanitizeSchema(x)])) : sanitizeSchema(v);
  }
  return out;
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
