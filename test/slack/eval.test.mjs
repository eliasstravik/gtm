// Runs eve's own eval tooling (`eve eval`, a local eve dev server, eve's real approval runtime) against the template
// with two fixture swaps: a scripted mockModel that calls start_run, and an eve channel the eval client can reach
// (the shipped one is deny-all). The evals live in eval-fixture/evals; a fake gtm API runs on 127.0.0.1:4803.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { missingEve } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skip = (await missingEve()) ?? false;

/** The node_modules that holds eve: the repo's own, else GTM_TEST_NODE_MODULES. */
function modules() {
  try {
    return join(dirname(createRequire(join(here, "../../package.json")).resolve("eve/package.json")), "..");
  } catch {
    return process.env.GTM_TEST_NODE_MODULES;
  }
}

test("eve eval: start_run waits for approval, a non-requester's yes is refused, a cancel starts nothing, a push waits for a yes", { skip, timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-slack-eval-"));
  try {
    cpSync(join(here, "../../slack/agent"), join(dir, "agent"), { recursive: true });
    cpSync(join(here, "eval-fixture/agent.ts"), join(dir, "agent/agent.ts"));
    cpSync(join(here, "eval-fixture/eve.ts"), join(dir, "agent/channels/eve.ts"));
    cpSync(join(here, "eval-fixture/evals"), join(dir, "evals"), { recursive: true });
    mkdirSync(join(dir, ".agents/skills"), { recursive: true });
    symlinkSync("../.agents/skills", join(dir, "agent/skills"));
    symlinkSync(modules(), join(dir, "node_modules"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gtm-slack-eval", private: true, type: "module", dependencies: { eve: "0.80.1", zod: "4.6.7" } }));
    const eve = join(dir, "node_modules/eve/bin/eve.js");
    assert.ok(existsSync(eve), "eve binary");
    const run = spawnSync(process.execPath, [eve, "eval", "--json"], {
      cwd: dir, encoding: "utf8", timeout: 280_000, env: { ...process.env, GTM_PORT: "4803", EVE_LOG_LEVEL: "error" },
    });
    const json = run.stdout.slice(run.stdout.indexOf("\n{") + 1);
    const report = JSON.parse(json.startsWith("{") ? json : run.stdout);
    const verdicts = Object.fromEntries(report.results.map((r) => [r.id, r.verdict]));
    assert.deepEqual(verdicts, { approve: "passed", cancel: "passed", push: "passed", requester: "passed" }, run.stderr.slice(-2000));
    assert.equal(run.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
