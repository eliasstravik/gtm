import { FatalError } from "workflow";
import { isHosted } from "../shared/env.js";
import { mcpAuth, type McpServer } from "./tools.js";

/**
 * The laptop-only backend of agent(): the whole stage runs inside one step through the unmodified `claude` or `codex`
 * binary the person is signed into. The CLI runs its own tool loop and its own default model; it never sees the app's
 * secrets, and MCP keys reach it only through a 0600 file (claude) or an environment variable (codex), never argv.
 */
export type CliBackend = "claude" | "codex";
export type Reasoning = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Usage = { inputTokens: number; outputTokens: number };

export type CliAgentOptions = {
  /** GTM_AGENT_BACKEND; else whichever binary is on PATH, claude first. */
  backend?: CliBackend;
  instructions: string;
  prompt: string;
  /** JSON Schema, already sanitized; omit for plain text. */
  schema?: Record<string, unknown>;
  reasoning?: Reasoning;
  mcp?: Record<string, McpServer>;
  web: boolean;
  timeoutMs: number;
};

export type CliAgentResult = { value: unknown; costUsd: number; modelCalls: number; usage: Usage };

/** Everything the CLIs need to find their own login and config; nothing of the app's. CLAUDE* is never passed. */
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|COLORTERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|SYSTEMROOT|SystemRoot|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|CODEX_HOME|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
const NOTICE = Symbol.for("gtm.planLimitsNotice");

/** Step, never retried: one CLI run from a neutral temp folder, killed at the stage's timeout. */
export async function runAgentCli(o: CliAgentOptions): Promise<CliAgentResult> {
  "use step";
  if (isHosted()) throw new FatalError("The claude and codex backends run only on a laptop");
  const [fs, os, path] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));
  const backend = o.backend ?? (onPath("claude") ? "claude" : onPath("codex") ? "codex" : undefined);
  if (!backend) throw new FatalError("agent() found no AI backend: set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY, run `vercel env pull`, or sign in to `claude` or `codex` on this computer");
  const g = globalThis as { [NOTICE]?: boolean };
  if (!g[NOTICE]) {
    g[NOTICE] = true;
    console.warn(`[gtm] agent() stages run on your own signed-in ${backend}. Big runs may hit your plan's limits` +
      `${backend === "claude" ? ` (Anthropic: plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK")` : ""}.` +
      " Setting AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY moves them to an API.");
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => KEEP.test(e[0]) && e[1] != null));
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gtm-agent-"));
  const file = (name: string, text: string) => fs.promises.writeFile(path.join(dir, name), text, { mode: 0o600 }).then(() => path.join(dir, name));
  const servers = Object.entries(o.mcp ?? {});
  const prompt = `${o.instructions}\n\n---\n\n${o.prompt}`;
  try {
    if (backend === "claude") {
      const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", o.web ? "WebSearch,WebFetch" : ""];
      if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
      if (o.reasoning) args.push("--effort", o.reasoning === "none" || o.reasoning === "minimal" ? "low" : o.reasoning);
      if (servers.length) {
        const config = Object.fromEntries(servers.map(([n, s]) => [n, { type: "http", url: s.url, headers: mcpAuth(s) }]));
        args.push("--mcp-config", await file("mcp.json", JSON.stringify({ mcpServers: config })));
      }
      const allowed = [...(o.web ? ["WebSearch", "WebFetch"] : []), ...servers.flatMap(([n, s]) => s.allow?.map((t) => `mcp__${n}__${t}`) ?? [`mcp__${n}`])];
      if (allowed.length) args.push("--allowedTools", ...allowed);
      const out = await run("claude", args, prompt, dir, env, o.timeoutMs);
      const reply = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown; total_cost_usd?: number; num_turns?: number;
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
      if (reply.is_error) throw new Error(`claude reported an error: ${String(reply.result ?? "").slice(0, 500)}`);
      const u = reply.usage ?? {};
      return {
        value: o.schema ? reply.structured_output ?? JSON.parse(reply.result ?? "null") : reply.result ?? "",
        costUsd: reply.total_cost_usd ?? 0,
        modelCalls: reply.num_turns ?? 1,
        usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 },
      };
    }
    const last = path.join(dir, "last.txt");
    const args = ["exec", "-", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-o", last];
    if (o.schema) args.push("--output-schema", await file("schema.json", JSON.stringify(o.schema)));
    if (o.reasoning) args.push("-c", `model_reasoning_effort="${o.reasoning === "minimal" ? "low" : o.reasoning}"`);
    if (o.web) args.push("-c", `web_search="live"`);
    servers.forEach(([n, s], i) => {
      // codex runs MCP tools unattended only when approved up front; the key travels in an env var it reads itself.
      args.push("-c", `mcp_servers.${n}.url=${JSON.stringify(s.url)}`, "-c", `mcp_servers.${n}.default_tools_approval_mode="approve"`);
      if (s.allow) args.push("-c", `mcp_servers.${n}.enabled_tools=${JSON.stringify(s.allow)}`);
      for (const [header, v] of Object.entries(mcpAuth(s))) {
        env[`GTM_MCP_KEY_${i}`] = header.toLowerCase() === "authorization" && v.startsWith("Bearer ") ? v.slice(7) : v;
        args.push("-c", header.toLowerCase() === "authorization" && v.startsWith("Bearer ")
          ? `mcp_servers.${n}.bearer_token_env_var="GTM_MCP_KEY_${i}"`
          : `mcp_servers.${n}.env_http_headers={ ${JSON.stringify(header)} = "GTM_MCP_KEY_${i}" }`);
      }
    });
    const events = (await run("codex", args, prompt, dir, env, o.timeoutMs)).split("\n").flatMap((l) => {
      try { return [JSON.parse(l) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } }]; } catch { return []; }
    });
    const turns = events.filter((e) => e.type === "turn.completed");
    const text = await fs.promises.readFile(last, "utf8");
    return {
      value: o.schema ? JSON.parse(text) : text.trim(),
      costUsd: 0,
      modelCalls: Math.max(1, turns.length),
      usage: { inputTokens: turns.reduce((n, e) => n + (e.usage?.input_tokens ?? 0), 0), outputTokens: turns.reduce((n, e) => n + (e.usage?.output_tokens ?? 0), 0) },
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
runAgentCli.maxRetries = 0;

/** Spawns in its own process group so a timeout kills the CLI and anything it started. */
async function run(cmd: string, args: string[], stdin: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "", err = "", bytes = 0, done = false;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
    };
    const stop = (error: Error) => {
      if (done) return;
      done = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
      reject(error);
    };
    const timer = setTimeout(() => stop(new Error(`${cmd} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`)), timeoutMs);
    const take = (data: Buffer, toOut: boolean) => {
      bytes += data.length;
      if (bytes > 8_000_000) return stop(new Error(`${cmd} wrote more than 8 MB of output`));
      if (toOut) out += data;
      else err = (err + data).slice(-2000);
    };
    child.stdout.on("data", (d: Buffer) => take(d, true));
    child.stderr.on("data", (d: Buffer) => take(d, false));
    child.stdin.on("error", () => undefined);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (!done) reject(e.code === "ENOENT" ? new FatalError(`${cmd} is not on PATH; install it and sign in, or set GTM_AGENT_BACKEND`) : e);
      done = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (code === 0) return resolve(out);
      const detail = (err.trim() || out.trim()).slice(-500);
      reject(new Error(`${cmd} exited with ${code ?? signal}${detail ? `: ${detail}` : ""}`));
    });
    child.stdin.end(stdin);
  });
}
