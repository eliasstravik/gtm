import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { appPort, value } from "../shared/env.js";
import { findProject, loadEnv } from "./project.js";

const USAGE = "Usage: gtm run <workflow> [--input <json>] [--prod] [--no-wait]";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * `gtm run <workflow> [--input <json>] [--prod] [--no-wait]`: starts a run with POST /api/gtm/start/<workflow> on
 * 127.0.0.1:$GTM_PORT (or GTM_PRODUCTION_URL with the bypass header), then polls it and prints status, return value
 * and error as JSON. Exits non-zero unless the run completed.
 */
export async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { input: { type: "string" }, prod: { type: "boolean" }, "no-wait": { type: "boolean" } },
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  loadEnv(findProject(), true);
  let body: string | undefined;
  if (values.input !== undefined) {
    try {
      body = JSON.stringify(JSON.parse(values.input));
    } catch {
      throw new Error(`--input must be JSON, e.g. --input '{"limit":5}'`);
    }
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  let base = `http://127.0.0.1:${appPort()}`;
  if (values.prod) {
    const url = value("GTM_PRODUCTION_URL");
    const secret = value("GTM_BYPASS_SECRET");
    if (!url || !secret) throw new Error("--prod needs GTM_PRODUCTION_URL and GTM_BYPASS_SECRET in .env.local (`npx @eliasstravik/gtm docs deploy`).");
    base = new URL(url.includes("://") ? url : `https://${url}`).origin;
    headers["x-vercel-protection-bypass"] = secret;
  }
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/api/gtm${path}`, { ...init, headers, redirect: "manual" }).catch((error: Error) => {
      throw new Error(values.prod ? `${base} is unreachable: ${error.message}` : `Nothing answers on ${base}; start \`npm run dev\` first.`);
    });
    if (res.status === 401 || (res.status >= 300 && res.status < 400))
      throw new Error(`Vercel's login answered instead of the app (${res.status}); GTM_BYPASS_SECRET is wrong or outdated.`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} from ${path}: ${json.error ?? res.statusText}`);
    return json;
  };
  const { runId } = await call(`/start/${encodeURIComponent(positionals[0])}`, { method: "POST", body });
  if (values["no-wait"]) return console.log(JSON.stringify({ runId }, null, 2));
  console.error(`Started run ${runId}; waiting for it to finish (Ctrl-C stops waiting, not the run).`);
  for (let misses = 0; ; ) {
    await sleep(1000);
    let state;
    try {
      state = await call(`/runs/${encodeURIComponent(runId)}`);
      misses = 0;
    } catch (error) {
      if ((misses += 1) >= 10) throw error;
      continue;
    }
    if (!TERMINAL.has(state.status)) continue;
    console.log(JSON.stringify({ runId, status: state.status, returnValue: state.returnValue ?? null, error: state.error ?? null }, null, 2));
    if (state.status !== "completed") process.exitCode = 1;
    return;
  }
}
