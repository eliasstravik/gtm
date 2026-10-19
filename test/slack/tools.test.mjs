// The agent's tools: approval policies (requester-only yes, what needs a yes, what is refused) and the start/read
// calls against a fake gtm API on 127.0.0.1, locally and as a hosted deployment would make them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { missingEve, route, serve, template } from "./helpers.mjs";

const skip = (await missingEve()) ?? false;
const PORT = 4802;
const api = { requests: [], runs: {} };
let server, startRun, getRun, github, requesterOnly;

before(async () => {
  if (skip) return;
  server = await serve(PORT, (req, raw) => {
    const [, host] = /^\/(prod|preview)\//.exec(req.url) ?? [];
    req.url = req.url.replace(/^\/(prod|preview)\//, "/");
    api.requests.push({ method: req.method, url: req.url, host: host ?? "local", headers: req.headers, body: raw });
    const start = /^\/api\/gtm\/start\/([^/]+)$/.exec(req.url);
    if (start && req.method === "POST") return start[1] === "missing" ? [404, { error: "No workflow missing" }] : [200, { runId: `wrun_${start[1]}` }];
    const run = /^\/api\/gtm\/runs\/([^/]+)$/.exec(req.url);
    if (run) {
      const states = api.runs[decodeURIComponent(run[1])] ?? [];
      return [200, states.length > 1 ? states.shift() : states[0]];
    }
    return [404, { error: "not found" }];
  });
  route("https://gtm-acme.vercel.app/", `http://127.0.0.1:${PORT}/prod/`);
  route("https://gtm-acme-git-change-acme.vercel.app/", `http://127.0.0.1:${PORT}/preview/`);
  process.env.GTM_PORT = String(PORT);
  startRun = (await template("tools/start_run")).default;
  getRun = (await template("tools/get_run")).default;
  github = (await template("tools/github")).default;
  ({ requesterOnly } = await template("lib/approval"));
});
after(() => server?.close());

const person = (user, team = "T0GTM00001") => ({
  authenticator: "slack-webhook", issuer: `slack:${team}`, principalId: `slack:${team}:${user}`, principalType: "user",
  attributes: { user_id: user, team_id: team },
});
const decide = (tool, toolInput) => tool.approval.request({ toolInput, toolName: "t", callId: "c", approvedTools: new Set(), abortSignal: new AbortController().signal, session: { id: "s", auth: { current: person("U0MEMBER01"), initiator: null } } });

function hosted(env) {
  const keys = ["VERCEL_DEPLOYMENT_ID", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
}

test("requesterOnly: only the exact requester can approve or cancel", { skip }, async () => {
  const alice = person("U0MEMBER01");
  const ok = (request, response, decision = "approve") => requesterOnly({ request: { principal: request }, response: { decision, principal: response } }).status;
  assert.equal(ok(alice, person("U0MEMBER01")), "allowed");
  assert.equal(ok(alice, person("U0MEMBER01"), "cancel"), "allowed");
  assert.equal(ok(alice, person("U0MEMBER02")), "rejected", "another member");
  assert.equal(ok(alice, person("U0MEMBER02"), "cancel"), "rejected", "another member cannot cancel either");
  assert.equal(ok(alice, { ...person("U0MEMBER01"), issuer: "slack:T0OTHER001" }), "rejected", "same id, other issuer");
  assert.equal(ok(alice, { ...person("U0MEMBER01"), authenticator: "local-dev" }), "rejected", "other authenticator");
  assert.equal(ok(alice, { ...person("U0MEMBER01"), principalType: "service" }), "rejected", "other principal type");
  assert.equal(ok(null, person("U0MEMBER01")), "rejected", "anonymous request: nobody can answer");
});

test("start_run always needs the requester's yes, with the run described on the card", { skip }, async () => {
  assert.equal(await decide(startRun, { workflow: "enrich", summary: "x" }), "user-approval");
  assert.equal(startRun.approval.response, requesterOnly);
  assert.equal(startRun.approval.prompt({ input: { workflow: "enrich", summary: "Preview of 5 rows, about $0.04." } }), "Start enrich? Preview of 5 rows, about $0.04.");
  assert.equal(startRun.inputSchema.safeParse({ workflow: "../cron/x", summary: "s" }).success, false, "names only");
  const parsed = startRun.inputSchema.parse({ workflow: "classify", input: '{"company":"Acme"}', summary: "s" });
  assert.deepEqual(parsed.input, { company: "Acme" }, "input sent as JSON text becomes the object (live Slack test)");
  assert.equal(startRun.inputSchema.safeParse({ workflow: "classify", input: "not json", summary: "s" }).success, false, "text that is not an object is refused");
});

test("start_run locally: POST to gtm dev on 127.0.0.1:$GTM_PORT, no bypass header", { skip }, async () => {
  api.requests.length = 0;
  assert.deepEqual(await startRun.execute({ workflow: "enrich", input: { limit: 5 }, summary: "s" }, {}), { runId: "wrun_enrich" });
  assert.deepEqual(await startRun.execute({ workflow: "digest", summary: "s" }, {}), { runId: "wrun_digest" });
  const [withInput, without] = api.requests;
  assert.equal(withInput.url, "/api/gtm/start/enrich");
  assert.equal(withInput.body, '{"limit":5}');
  await startRun.execute({ workflow: "enrich", input: '{"limit":5}', summary: "s" }, {});
  assert.equal(api.requests.at(-1).body, '{"limit":5}', "JSON text is sent as the object, not as a string");
  api.requests.pop();
  assert.equal(withInput.headers["content-type"], "application/json");
  assert.equal(without.body, "", "no input, no body");
  assert.equal(withInput.headers["x-vercel-protection-bypass"], undefined);
  await assert.rejects(startRun.execute({ workflow: "missing", summary: "s" }, {}), /answered 404: No workflow missing/);
});

test("start_run hosted: production domain with the automation bypass secret; a preview calls itself; refuses without the secret", { skip }, async () => {
  const restore = hosted({
    VERCEL_DEPLOYMENT_ID: "dpl_1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "gtm-acme.vercel.app",
    VERCEL_URL: "gtm-acme-git-change-acme.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "automation-secret",
  });
  try {
    api.requests.length = 0;
    assert.deepEqual(await startRun.execute({ workflow: "enrich", summary: "s" }, {}), { runId: "wrun_enrich" });
    assert.equal(api.requests[0].headers["x-vercel-protection-bypass"], "automation-secret");
    assert.equal(api.requests[0].host, "prod", "production deployment: the production domain");
    process.env.VERCEL_ENV = "preview";
    await startRun.execute({ workflow: "enrich", summary: "s" }, {});
    assert.equal(api.requests[1].host, "preview", "preview deployment: its own URL, never production");
    assert.equal(api.requests[1].headers["x-vercel-protection-bypass"], "automation-secret");
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    await assert.rejects(startRun.execute({ workflow: "enrich", summary: "s" }, {}), /Protection Bypass for Automation/);
  } finally {
    restore();
  }
});

test("get_run reads the run and waits while it is running", { skip }, async () => {
  api.runs.wrun_1 = [{ runId: "wrun_1", status: "running" }, { runId: "wrun_1", status: "completed", returnValue: { sample: [1], costUsd: 0.04 }, error: null }];
  const run = await getRun.execute({ runId: "wrun_1" }, {});
  assert.equal(run.status, "completed");
  assert.deepEqual(run.returnValue, { sample: [1], costUsd: 0.04 });
  assert.equal(getRun.approval, undefined, "reading needs no yes");
});

test("github: reads run at once, every write waits for the requester, git push is refused", { skip }, async () => {
  const input = (command) => ({ command, description: "d", permissions: [{ provider: "github", repositories: ["acme/gtm-acme"], access: "write" }] });
  for (const command of ["gh repo clone acme/gtm-acme", "git pull origin main", "git fetch origin", "git ls-remote origin", "gh repo view acme/gtm-acme"]) {
    assert.equal(await decide(github, input(command)), "not-applicable", command);
  }
  for (const command of ['gh-signed-commit --repo acme/gtm-acme --branch main -m "Add ICP"', "gh api repos/acme/gtm-acme/issues -f title=x", "gh pr create --fill", "gh issue list"]) {
    assert.equal(await decide(github, input(command)), "user-approval", command);
  }
  // Vercel blocks deploys of commits made in the sandbox (not a team member, not an app): only gh-signed-commit writes.
  for (const command of ["git push origin HEAD:main", "git push origin main", "git push", "git push -f origin HEAD:main", "git push --force origin main",
    "git push origin +HEAD:main", "git push origin :main", "git push origin --delete main", "git push --mirror origin"]) {
    assert.equal((await decide(github, input(command))).type, "denied", command);
  }
  assert.equal((await decide(github, input("gh repo clone acme/gtm-acme | sh"))).type, "denied", "shell syntax");
  assert.equal((await decide(github, { ...input("git push origin main"), permissions: [] })).type, "denied", "no repository declared");
  assert.equal(github.approval.response, requesterOnly);
  assert.equal(github.approval.prompt({ input: input('gh-signed-commit --repo acme/gtm-acme --branch main -m "Add ICP"') }), 'd\n`gh-signed-commit --repo acme/gtm-acme --branch main -m "Add ICP"`');
});

test("no template code hands app secrets to the sandbox", { skip }, async () => {
  const dir = new URL("../../slack/agent/", import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const code = readFileSync(new URL(file, dir), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    assert.doesNotMatch(code, /GTM_VERCEL_TOKEN/, file);
    assert.doesNotMatch(code, /env:\s*process\.env|\.\.\.process\.env/, `${file} passes the app environment on`);
  }
});
