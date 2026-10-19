import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type AddressInfo, createServer } from "node:net";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { appPort, value } from "../shared/env.js";
import { type LocalDatabase, accepts, startDevDatabase } from "./localdb.js";
import { migrate } from "./migrate.js";
import { findProject, loadEnv } from "./project.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** `gtm dev`: the local database when DATABASE_URL is unset, pending migrations, then `next dev` on 127.0.0.1. */
export async function dev(args: string[]): Promise<void> {
  // next and eve get the shell's env plus only ours: they read the env files themselves, and a value passed as a real
  // variable would win over .env.local, so a Connections Save there would apply only after a restart.
  const own: NodeJS.ProcessEnv = { ...process.env, GTM_DEV: "1" };
  process.env.GTM_DEV = "1"; // never hosted, whatever env files say
  const dir = findProject();
  const port = appPort(loadEnv(dir, true));
  const next = nextBin(dir);
  let local: LocalDatabase | undefined;
  if (!value("DATABASE_URL")) {
    local = await startDevDatabase(dir);
    own.DATABASE_URL = local.url;
    console.log(`gtm dev: local database at ${local.url}`);
  }
  let eve: { child: ChildProcess; url: string } | undefined;
  try {
    await migrate(dir, local?.url ?? value("DATABASE_URL")!);
    if (existsSync(join(dir, "agent"))) eve = await startEve(dir, own);
  } catch (error) {
    await local?.stop();
    throw error;
  }
  const env = { ...own, PORT: String(port), WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`, ...(eve && { EVE_BASE_URL: eve.url }) };
  const child = spawn(process.execPath, [next, "dev", "-H", "127.0.0.1", "-p", String(port), ...args], { cwd: dir, env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); eve?.child.kill(signal); };
  for (const signal of SIGNALS) process.on(signal, forward);
  const code = await new Promise<number>((done) => {
    child.once("error", (error) => { console.error(error.message); done(1); });
    child.once("exit", (status, signal) => done(status ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  for (const signal of SIGNALS) process.off(signal, forward);
  const e = eve?.child;
  if (e && e.exitCode === null && e.signalCode === null) await Promise.all([once(e, "exit"), e.kill("SIGTERM")]);
  await local?.stop();
  process.exitCode = code;
}

/** The project's own `next` CLI script. */
function nextBin(dir: string): string {
  try {
    const pkg = createRequire(join(dir, "package.json")).resolve("next/package.json");
    return join(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.next);
  } catch {
    throw new Error("next is not installed in this project: run `npm install`.");
  }
}

/**
 * With agent/: eve's dev server on 127.0.0.1 and a free port, started by us so the bind is explicit. withEve then
 * starts none of its own and only rewrites /eve/v1/* to EVE_BASE_URL.
 */
async function startEve(dir: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string }> {
  const pkg = join(dir, "node_modules", "eve", "package.json");
  if (!existsSync(pkg)) throw new Error("agent/ is present but eve is not installed: run `npm install`.");
  const { bin } = JSON.parse(readFileSync(pkg, "utf8"));
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  const args = [join(dirname(pkg), typeof bin === "string" ? bin : bin.eve), "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: "inherit" });
  for (const deadline = Date.now() + 60_000; !(await accepts(port)); await sleep(200)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error("eve's dev server did not start on 127.0.0.1 (see its output above).");
    }
  }
  return { child, url: `http://127.0.0.1:${port}` };
}
