/**
 * Acceptance checks §7.1–8 of the plan, against an `npm pack` tarball of this package.
 *
 * Usage:
 *   npm test                                   # packs a copy of this repo first (needs `npm ci` done here)
 *   GTM_TEST_TARBALL=/abs/eliasstravik-gtm-0.0.1-rc.N.tgz node --test test/acceptance.test.mjs
 * Optional env: GTM_TEST_TARBALL (skip packing) · GTM_TEST_DIR (parent of the temp work folder; default the OS temp
 * dir) · GTM_TEST_LOGS (where every command's log goes; default <work>/logs, kept) · GTM_TEST_PORT (first of three
 * consecutive ports; default 4710) · GTM_TEST_KEEP=1 (keep the project and its node_modules).
 * Needs Linux (`ss`, /proc), tar, openssl and the npm registry. One shared project, so order matters:
 * 7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 7.8 → 7.7 → 7.6 (`init --slack` adds eve, so it goes last).
 *
 * Every command runs with an empty environment except PATH and HOME (needed to run anything at all) and the
 * harness's NEXT_TELEMETRY_DISABLED=1 (and eve's EVE_TELEMETRY_DISABLED=1, which `eve dev`/`eve build` honour), plus
 * the variables a check sets on purpose (GTM_PORT, the test-only
 * GTM_PACKAGE_SPEC=file:<tarball> that points the starter's dependency at the tarball, …).
 * Network: §7 runs this inside a sandbox that allows only the npm registry. CI does that with a firewall on the
 * test user (.github/workflows/ci.yml). A local run cannot sandbox: it reaches whatever the package reaches.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  MIN, assertOk, cleanEnv, diffSnapshots, extractCli, httpsStub, killInside, listeningSockets, makeWorkDir, packPackage, poll,
  portOpen, processTree, request, run, setLogDir, snapshot, sql, startProcess, stopAll, tail, waitForHttp, within,
} from "./helpers.mjs";

const PORT = Number(process.env.GTM_TEST_PORT ?? 4710); // gtm dev
const START_PORT = PORT + 1; // hosted-mode `next start` (7.8)
const PROBE_PORT = PORT + 2; // HTTPS stand-in for Vercel's login wall (7.8)
const BOX = "box.tail.ts.net";
const PRODUCTION_DB = /production's database/i;

/** Shared across the checks, in order. */
const s = { work: "", tarball: "", cli: "", dir: "", dev: null, dbUrl: "", runId: "", block: "", marker: "" };

const file = (rel) => path.join(s.dir, rel);
const read = (rel) => fs.readFileSync(file(rel), "utf8");
const write = (rel, text) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), text); };
const exists = (rel) => fs.existsSync(file(rel));
const bin = () => file("node_modules/.bin/gtm");
const gtm = (args, { env = {}, timeout = 10 * MIN } = {}) =>
  run(bin(), args, { cwd: s.dir, env: cleanEnv(env), timeout, name: `gtm-${args[0]}` });
const npm = (args, { env = {}, timeout = 20 * MIN } = {}) =>
  run("npm", args, { cwd: s.dir, env: cleanEnv(env), timeout, name: `npm-${args.at(-1)}` });
const init = (args = []) => run("node", [s.cli, "init", s.dir, ...args], {
  cwd: s.work, env: cleanEnv({ GTM_PACKAGE_SPEC: `file:${s.tarball}` }), timeout: 20 * MIN, name: `gtm-init${args.join("")}`,
});
const get = (pathname, opts) => request(PORT, pathname, opts).catch((error) => {
  // Name the real cause when gtm dev is gone (a crash, or something outside the harness killing it).
  if (s.dev?.exitCode !== undefined) error.message += ` (gtm dev exited ${s.dev.exitCode}; log ${s.dev.log})`;
  throw error;
});
const ready = () => Boolean(s.dir) && exists("node_modules/.bin/gtm");
const BLOCK = /<!-- BEGIN:gtm -->[\s\S]*?<!-- END:gtm -->/;

async function json(pathname, opts) {
  const r = await get(pathname, opts);
  assert.equal(r.status, 200, `GET ${pathname} → ${r.status}: ${r.text.slice(0, 500)}`);
  return r.json();
}

/** A refusal: 4xx, and not "no such route" (404) or "wrong method" (405), so a missing route cannot pass as a guard. */
function refused(r, what) {
  assert.ok(r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 405,
    `${what} should be refused, got ${r.status}: ${r.text.slice(0, 300)}`);
}

async function startDev(env = {}) {
  assert.ok(await poll(async () => !(await portOpen(PORT)), { timeout: 30_000 }), `port ${PORT} is still in use`);
  const proc = startProcess(bin(), ["dev"], { cwd: s.dir, env: cleanEnv({ GTM_PORT: String(PORT), ...env }), name: "gtm-dev" });
  s.dev = proc;
  await waitForHttp(PORT, "/api/gtm/shell", proc);
  // The PGlite server gets a new port on every start; the URL form is the local-database convention.
  s.dbUrl = `postgres://postgres:postgres@127.0.0.1:${JSON.parse(read(".gtm/db.lock")).port}/postgres?sslmode=disable`;
  return proc;
}

async function stopDev() {
  if (!s.dev) return;
  await s.dev.stop();
  s.dev = null;
  await poll(async () => !(await portOpen(PORT)), { timeout: 30_000 });
}

async function ensureDev() {
  if (!s.dev || s.dev.exitCode !== undefined) await startDev();
}

/** Every listening socket of gtm dev's process tree (and anything running inside the project folder). */
function devSockets() {
  return listeningSockets(processTree(s.dev.pid, s.dir));
}

function assertLoopbackOnly(sockets) {
  assert.ok(sockets.length > 0, "found no listening sockets for gtm dev");
  const outside = sockets.filter((x) => x.address !== "127.0.0.1" && x.address !== "::ffff:127.0.0.1");
  assert.deepEqual(outside, [], `sockets not on 127.0.0.1: ${JSON.stringify(outside)}`);
  assert.ok(sockets.some((x) => x.port === PORT), `nothing listens on 127.0.0.1:${PORT}: ${JSON.stringify(sockets)}`);
}

/** The local DATABASE_URL that `gtm check` prints (while gtm dev holds the database, it is the live server's). */
async function localDatabaseUrl() {
  const check = await gtm(["check"]);
  const url = check.output.match(/postgres(?:ql)?:\/\/[^\s'"`]+/)?.[0];
  assert.ok(url, `gtm check printed no DATABASE_URL:\n${tail(check.output)}`);
  return url;
}

async function runsCount() {
  return (await json("/api/gtm/workflows")).runs.length;
}

before(async () => {
  s.work = makeWorkDir();
  setLogDir(process.env.GTM_TEST_LOGS ?? path.join(s.work, "logs"));
  s.tarball = await packPackage(s.work);
  s.cli = await extractCli(s.tarball, s.work);
}, { timeout: 15 * MIN });

after(async () => {
  await stopAll();
  if (!s.work) return;
  const strays = killInside(s.work);
  if (strays.length) console.error(`# killed ${strays.length} process(es) still running in ${s.work}:\n# ${strays.join("\n# ")}`);
  if (process.env.GTM_TEST_KEEP === "1") return;
  for (const name of fs.readdirSync(s.work)) if (name !== "logs") fs.rmSync(path.join(s.work, name), { recursive: true, force: true });
  if (!fs.readdirSync(s.work).length) fs.rmdirSync(s.work);
});

test("7.1 init into an empty folder → npm run build passes → gtm check exits 0, no env vars set", { timeout: 40 * MIN }, async () => {
  s.dir = path.join(s.work, "acme-gtm");
  fs.mkdirSync(s.dir);
  assertOk(await init(), "gtm init");
  assert.ok(ready(), "init did not install the package (node_modules/.bin/gtm missing)");
  const installed = JSON.parse(read("node_modules/@eliasstravik/gtm/package.json"));
  const packed = JSON.parse(fs.readFileSync(path.join(s.cli, "..", "..", "package.json"), "utf8"));
  assert.equal(installed.version, packed.version, "the project must run the packed tarball");
  // What init must leave behind (§2), which later checks rely on.
  assert.ok(exists(".gitignore"), ".gitignore (renamed from starter/gitignore)");
  assert.equal(fs.readlinkSync(file(".claude/skills")), "../.agents/skills");
  s.block = read("AGENTS.md").match(BLOCK)?.[0] ?? "";
  assert.ok(s.block, "AGENTS.md has the managed block");
  assertOk(await npm(["run", "build"]), "npm run build");
  assertOk(await gtm(["check"]), "gtm check");
});

test("7.2 gtm dev: 127.0.0.1 only; four views + API with the local database and an empty context/; build/migrate/check alongside",
  { timeout: 40 * MIN }, async (t) => {
    if (!ready()) return t.skip("no project (7.1 failed)");
    const stash = path.join(s.work, "context-stash");
    fs.renameSync(file("context"), stash);
    fs.mkdirSync(file("context"));
    try {
      await startDev();
      await t.test("every listening socket of its process tree is on 127.0.0.1", (st) => {
        const sockets = devSockets();
        st.diagnostic(`listening: ${sockets.map((x) => x.local).join(" ")}`);
        assertLoopbackOnly(sockets);
        const lock = JSON.parse(read(".gtm/db.lock"));
        assert.ok(sockets.some((x) => x.port === lock.port), `the PGlite server (lock port ${lock.port}) is not in the tree`);
      });
      await t.test("the four views (and /) render as HTML", async () => {
        for (const view of ["/", "/context", "/workflows", "/data", "/connections"]) {
          const r = await get(view);
          assert.equal(r.status, 200, `GET ${view} → ${r.status}: ${r.text.slice(0, 300)}`);
          assert.match(String(r.headers["content-type"]), /text\/html/, view);
        }
        assert.equal((await get("/no-such-view")).status, 404, "unknown first segment → 404");
      });
      await t.test("their API endpoints return the contract JSON", async () => {
        const shell = await json("/api/gtm/shell");
        assert.equal(shell.company, "GTM", "no context/company.md → company 'GTM'");
        assert.equal(shell.environment, "local");
        assert.equal(shell.database, "127.0.0.1", "database = identity of the local URL");
        assert.deepEqual(shell.artifacts, []);
        const context = await json("/api/gtm/context");
        const ctx = context.groups.find((g) => g.name === "Context");
        assert.ok(ctx, JSON.stringify(context));
        assert.deepEqual(ctx.files.map((f) => f.path), [], "an empty context/ lists nothing under Context");
        for (const g of context.groups) assert.ok(["Context", "Skills"].includes(g.name) && Array.isArray(g.files), JSON.stringify(g));
        assert.deepEqual(context.groups.find((g) => g.name === "Skills")?.files.map((f) => f.path), ["AGENTS.md"], "AGENTS.md is under Skills (§4)");
        const agents = await json("/api/gtm/context/file?path=AGENTS.md");
        assert.equal(agents.path, "AGENTS.md");
        assert.ok(agents.markdown.includes("<!-- BEGIN:gtm -->"));
        assert.equal(agents.githubUrl, null);
        const unlisted = await get("/api/gtm/context/file?path=package.json");
        assert.ok(unlisted.status >= 400 && unlisted.status < 500, `a file the listing does not return → ${unlisted.status}`);
        const workflows = await json("/api/gtm/workflows");
        assert.deepEqual(workflows.workflows, []);
        assert.ok(Array.isArray(workflows.runs));
        assert.equal(workflows.runsUrl, null);
        assert.deepEqual(await json("/api/gtm/data"), { tables: [] });
        const connections = await json("/api/gtm/connections");
        assert.ok(Array.isArray(connections.connections));
        for (const c of connections.connections) {
          assert.ok(typeof c.name === "string" && typeof c.description === "string" && typeof c.set === "boolean", JSON.stringify(c));
        }
        assert.equal(connections.save.mode, "local");
        assert.equal(connections.tokenWarning, null);
      });
    } finally {
      fs.rmSync(file("context"), { recursive: true, force: true });
      fs.renameSync(stash, file("context"));
    }
    await t.test("while it runs: npm run build, gtm migrate and gtm check succeed", async () => {
      assertOk(await npm(["run", "build"]), "npm run build (gtm dev running)");
      assertOk(await gtm(["migrate"]), "gtm migrate (gtm dev running)");
      assert.equal(await localDatabaseUrl(), s.dbUrl, "gtm check prints the live server's URL");
      assert.equal(s.dev.exitCode, undefined, "gtm dev is still running");
      assert.equal((await get("/api/gtm/shell")).status, 200);
    });
  });

test("7.3 context file shows; a one-step workflow writing a row: db:generate → gtm migrate (dev running) → gtm run → Workflows and Data",
  { timeout: 30 * MIN }, async (t) => {
    if (!ready()) return t.skip("no project (7.1 failed)");
    await ensureDev();
    write("context/icps/mid-market.md", "# Mid-market SaaS\n\nCompanies with 200–2,000 employees.\n");
    await t.test("context/icps/mid-market.md shows in Context", async () => {
      const ctx = (await json("/api/gtm/context")).groups.find((g) => g.name === "Context");
      const entry = ctx.files.find((f) => f.path === "context/icps/mid-market.md");
      assert.ok(entry, JSON.stringify(ctx.files));
      assert.equal(entry.title, "Mid-market SaaS");
      const body = await json("/api/gtm/context/file?path=context/icps/mid-market.md");
      assert.match(body.markdown, /200–2,000 employees/);
    });

    fs.appendFileSync(file("db/schema.ts"), `
import * as acceptancePg from "drizzle-orm/pg-core";

/** Acceptance check 7.3: a workflow-owned table. */
export const records = acceptancePg.pgTable("records", {
  id: acceptancePg.serial("id").primaryKey(),
  name: acceptancePg.text("name").notNull(),
});
`);
    write("workflows/record.ts", `import { db } from "@eliasstravik/gtm/db";
import { records } from "../db/schema";

async function insertRecord(name: string) {
  "use step";
  const [row] = await db().insert(records).values({ name }).returning();
  return { id: row.id, name: row.name };
}

/** Acceptance check 7.3: one step that writes a row. */
export async function record(input: { name: string }) {
  "use workflow";
  return { inserted: await insertRecord(input.name) };
}
`);
    const registry = read("workflows/index.ts");
    const registered = registry.replace(/export const workflows\s*=\s*\{\s*\}/, "export const workflows = { record }");
    assert.notEqual(registered, registry, `cannot register in workflows/index.ts:\n${registry}`);
    write("workflows/index.ts", `import { record } from "./record";\n${registered}`);

    await t.test("db:generate writes a migration; gtm migrate applies it while gtm dev runs", async () => {
      assertOk(await npm(["run", "db:generate"]), "npm run db:generate");
      const sqlFiles = fs.readdirSync(file("db/migrations")).filter((f) => f.endsWith(".sql"));
      assert.ok(sqlFiles.some((f) => /CREATE TABLE "records"/.test(read(`db/migrations/${f}`))), `no migration creates "records": ${sqlFiles}`);
      assertOk(await gtm(["migrate"]), "gtm migrate");
    });

    await t.test("gtm run waits and prints the return value; the run shows in Workflows", async () => {
      const listed = await poll(async () => (await json("/api/gtm/workflows")).workflows.some((w) => w.name === "record"), { timeout: 2 * MIN });
      assert.ok(listed, "record never appeared in /api/gtm/workflows");
      s.marker = `acceptance-row-${Date.now()}`;
      const result = assertOk(await gtm(["run", "record", "--input", JSON.stringify({ name: s.marker })], { env: { GTM_PORT: String(PORT) } }), "gtm run");
      assert.ok(result.stdout.includes(s.marker), `return value not printed:\n${result.output}`);
      assert.match(result.stdout, /completed/i);
      let printedId;
      try { printedId = JSON.parse(result.stdout).runId; } catch { printedId = result.output.match(/wrun_[A-Za-z0-9]+/)?.[0]; }
      const runs = await poll(async () => {
        const list = (await json("/api/gtm/workflows")).runs;
        return list.some((r) => /record/.test(r.workflow) && r.status === "completed") && list;
      }, { timeout: MIN });
      assert.ok(runs, "no completed record run in /api/gtm/workflows");
      const run = runs.find((r) => (printedId ? r.id === printedId : /record/.test(r.workflow)));
      assert.ok(run, `run ${printedId} not listed: ${JSON.stringify(runs)}`);
      for (const k of ["id", "workflow", "status", "createdAt"]) assert.equal(typeof run[k], "string", k);
      assert.ok(run.durationMs === null || typeof run.durationMs === "number");
      s.runId = run.id;
    });

    await t.test("the table and the row show in Data", async () => {
      const { tables } = await json("/api/gtm/data");
      const table = tables.find((x) => x.name === "records");
      assert.ok(table, JSON.stringify(tables));
      assert.ok(table.estimatedRows === null || typeof table.estimatedRows === "number");
      const page = await json("/api/gtm/data/records");
      assert.equal(page.table, "records");
      assert.ok(page.columns.includes("name"), JSON.stringify(page.columns));
      assert.ok(page.rows.some((row) => row.includes(s.marker)), JSON.stringify(page.rows));
      assert.equal(page.pageSize, 100);
      assert.equal(page.hasMore, false);
      const csv = await get("/api/gtm/data/records/csv");
      assert.equal(csv.status, 200);
      assert.match(String(csv.headers["content-type"]), /text\/csv/);
      assert.ok(csv.text.includes(s.marker));
    });
  });

test("7.4 Connections: lists .env.example; Save writes .env.local and flips to set; values round-trip; refusals",
  { timeout: 15 * MIN }, async (t) => {
    if (!ready()) return t.skip("no project (7.1 failed)");
    await ensureDev();
    const example = read(".env.example");
    let add = "\n# Acme CRM API key (acceptance check)\nACME_API_KEY=\n# Acme webhook signing token (acceptance check)\nACME_WEBHOOK_TOKEN=\n";
    // Refused names listed too, so their refusal is the name rule and not "unlisted".
    if (!/^DATABASE_URL=/m.test(example)) add += "# Postgres connection string\nDATABASE_URL=\n";
    if (!/^SLACK_SIGNING_SECRET=/m.test(example)) add += "# Slack signing secret\nSLACK_SIGNING_SECRET=\n";
    fs.appendFileSync(file(".env.example"), add);
    const origin = { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" };
    const save = (name, value) => get("/api/gtm/connections", { method: "POST", headers: origin, body: { name, value } });
    const status = async (name) => (await json("/api/gtm/connections")).connections.find((c) => c.name === name);
    /** The value as Next would load it from the project's env files (in a fresh process). */
    const loaded = async (name) => {
      const r = assertOk(await run("node", ["-e", `const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() {} }, true);
process.stdout.write(JSON.stringify(process.env[${JSON.stringify(name)}] ?? null));`], { cwd: s.dir, name: "loadEnvConfig" }));
      return JSON.parse(r.stdout);
    };

    await t.test("lists the .env.example names with their comments", async () => {
      const api = await status("ACME_API_KEY");
      assert.ok(api, "ACME_API_KEY listed");
      assert.match(api.description, /Acme CRM API key/);
      assert.equal(api.set, false);
      assert.equal((await status("ACME_WEBHOOK_TOKEN"))?.set, false);
    });

    const tricky = 'p$ss"wo\\rd$HOME-${PATH}\\z';
    const quoted = "it's $5 \"off\" \\o/ ok";
    await t.test("Save writes .env.local, the status flips to set, $ \" \\ read back unchanged via loadEnvConfig", async () => {
      for (const [name, value] of [["ACME_API_KEY", tricky], ["ACME_WEBHOOK_TOKEN", quoted]]) {
        const r = await save(name, value);
        assert.equal(r.status, 200, `Save ${name} → ${r.status}: ${r.text}`);
        assert.equal(r.json().ok, true);
        assert.match(read(".env.local"), new RegExp(`^${name}=`, "m"));
        assert.ok(await poll(async () => (await status(name))?.set, { timeout: 30_000 }), `${name} never showed as set`);
        assert.equal(await loaded(name), value, `${name} round-trip through @next/env`);
      }
    });

    await t.test("Save refuses DATABASE_URL, SLACK_SIGNING_SECRET, an unlisted name and a multi-line value", async () => {
      const before = read(".env.local");
      for (const [name, value] of [["DATABASE_URL", "postgres://x@db.example/x"], ["SLACK_SIGNING_SECRET", "abc"],
        ["NOT_IN_ENV_EXAMPLE", "abc"], ["ACME_API_KEY", "line1\nline2"]]) {
        const r = await save(name, value);
        assert.ok(r.status >= 400 && r.status < 500, `Save ${name}=${JSON.stringify(value)} → ${r.status}: ${r.text}`);
        assert.equal(r.json().ok, false);
        assert.equal(typeof r.json().error, "string");
      }
      assert.equal(read(".env.local"), before, ".env.local unchanged by refused saves");
      assert.equal(await loaded("ACME_API_KEY"), tricky);
    });
  });

test("7.5 app/pipeline/page.tsx shows under Artifacts and renders in the shell, without restarting gtm dev", { timeout: 10 * MIN }, async (t) => {
  if (!ready()) return t.skip("no project (7.1 failed)");
  await ensureDev();
  const pid = s.dev.pid;
  write("app/pipeline/page.tsx", `export default function Pipeline() {
  return <main><h1>Pipeline</h1><p>acceptance-pipeline-marker</p></main>;
}
`);
  const listed = await poll(async () => (await json("/api/gtm/shell")).artifacts.includes("pipeline"), { timeout: MIN });
  assert.ok(listed, `pipeline not in /api/gtm/shell artifacts: ${JSON.stringify((await json("/api/gtm/shell")).artifacts)}`);
  const r = await get("/pipeline");
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.includes("acceptance-pipeline-marker"), "page content");
  for (const view of ["/workflows", "/data", "/connections"]) {
    assert.ok(r.text.includes(`href="${view}"`), `the shell's menu (${view}) wraps the page`);
  }
  assert.ok(r.text.includes('href="/context"') || r.text.includes('href="/"'), "the shell's menu (Context) wraps the page");
  assert.ok(r.text.includes('class="gtm-sidebar"') && r.text.includes('aria-label="Open menu"'), "sidebar, and a menu button for narrow screens");
  assert.equal(s.dev.pid, pid);
  assert.equal(s.dev.exitCode, undefined, "gtm dev was not restarted");
});

test("7.8 guards and safety", { timeout: 60 * MIN }, async (t) => {
  if (!ready()) return t.skip("no project (7.1 failed)");
  await ensureDev();
  const workflow = s.runId ? "record" : "missing";

  await t.test("POST start with a foreign Origin or Sec-Fetch-Site: cross-site → 403, no run started", async () => {
    const before = await runsCount();
    for (const headers of [{ origin: "http://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const r = await get(`/api/gtm/start/${workflow}`, { method: "POST", headers, body: { name: "evil" } });
      assert.equal(r.status, 403, `${JSON.stringify(headers)} → ${r.status}: ${r.text.slice(0, 300)}`);
      // The same guard covers every route (§3): Save and the Workflow SDK's own endpoint.
      const envLocal = exists(".env.local") ? read(".env.local") : null;
      const save = await get("/api/gtm/connections", { method: "POST", headers, body: { name: "ACME_API_KEY", value: "evil" } });
      assert.equal(save.status, 403, `Save ${JSON.stringify(headers)} → ${save.status}`);
      assert.equal(exists(".env.local") ? read(".env.local") : null, envLocal, ".env.local unchanged");
      const flow = await get("/.well-known/workflow/v1/flow", { method: "POST", headers, body: {} });
      assert.equal(flow.status, 403, `workflow flow route ${JSON.stringify(headers)} → ${flow.status}`);
    }
    assert.equal(await runsCount(), before);
  });

  await t.test("Host: evil.test is refused on a cockpit view and on app/pipeline", async () => {
    for (const p of ["/context", "/pipeline", "/api/gtm/shell"]) {
      assert.equal((await get(p)).status, 200, `${p} control on 127.0.0.1`);
      refused(await get(p, { host: "evil.test" }), `Host evil.test on ${p}`);
      refused(await get(p, { host: `evil.test:${PORT}` }), `Host evil.test:${PORT} on ${p}`);
    }
    const flow = await get("/.well-known/workflow/v1/flow", { method: "POST", host: "evil.test", body: {} });
    assert.equal(flow.status, 403, `Host evil.test on the workflow flow route → ${flow.status}`);
  });

  await t.test("the cron route refuses when CRON_SECRET is unset", async () => {
    const before = await runsCount();
    for (const authorization of [undefined, "Bearer", "Bearer ", "Bearer undefined", "Bearer null"]) {
      const r = await get(`/api/gtm/cron/${workflow}`, { headers: authorization === undefined ? {} : { authorization } });
      if (r.status !== 503) refused(r, `cron with authorization ${JSON.stringify(authorization)}`);
    }
    assert.equal(await runsCount(), before);
  });

  await t.test("hosted mode: bypass-carrying requests are refused on pages and cockpit read endpoints", async (st) => {
    assertOk(await npm(["run", "build"]), "npm run build");
    // Fail-closed probe (§3): the proxy fetches https://<Host>/_gtm/probe.txt. A local HTTPS stub answering 401
    // stands in for Vercel's login wall, so the proxy believes the deployment is protected; the requests below use
    // that stub's host:port as Host. Without it every request would get the 503 fail-closed notice instead.
    let probes = 0;
    const stub = await httpsStub(s.work, PROBE_PORT, (req, res) => {
      if (req.url.startsWith("/_gtm/probe.txt")) probes += 1;
      res.writeHead(401, { "content-type": "text/plain" }).end("Authentication Required");
    });
    const host = `127.0.0.1:${PROBE_PORT}`;
    const next = startProcess(file("node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(START_PORT)], {
      cwd: s.dir, name: "next-start-hosted",
      env: cleanEnv({
        VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test", VERCEL_AUTOMATION_BYPASS_SECRET: "s",
        DATABASE_URL: s.dbUrl, NODE_EXTRA_CA_CERTS: stub.caFile,
      }),
    });
    try {
      await waitForHttp(START_PORT, "/_gtm/probe.txt", next);
      const at = (p, headers = {}) => request(START_PORT, p, { host, headers });
      const shell = await at("/api/gtm/shell");
      assert.equal(shell.status, 200, `control without bypass: ${shell.status} ${shell.text.slice(0, 300)}`);
      assert.equal(shell.json().environment, "production");
      assert.ok(probes > 0, "the proxy never requested /_gtm/probe.txt");
      st.diagnostic(`probe requests answered 401 by the stub: ${probes}`);
      assert.equal((await at("/data")).status, 200, "control: /data without bypass");
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: host, bypass: "s", iat: 1, sub: "protection-bypass-automation" })}.sig`;
      const carriers = [
        ["header (the automation secret)", (p) => at(p, { "x-vercel-protection-bypass": "s" })],
        ["header (another secret)", (p) => at(p, { "x-vercel-protection-bypass": "slack-secret" })],
        ["query parameter", (p) => at(`${p}${p.includes("?") ? "&" : "?"}x-vercel-protection-bypass=s`)],
        ["bypass cookie", (p) => at(p, { cookie: `_vercel_jwt=${jwt}` })],
      ];
      const targets = ["/data", "/context", "/pipeline", "/", "/api/gtm/shell", "/api/gtm/context", "/api/gtm/context/file?path=AGENTS.md",
        "/api/gtm/workflows", "/api/gtm/data", "/api/gtm/data/records", "/api/gtm/data/records/csv", "/api/gtm/connections"];
      for (const [how, send] of carriers) for (const p of targets) refused(await send(p), `${how} on ${p}`);
    } finally {
      await next.stop();
      await stub.close();
    }
  });

  await t.test(`GTM_ALLOWED_HOSTS=${BOX}: that host is admitted, but start and runs are refused on it`, async () => {
    await stopDev();
    await startDev({ GTM_ALLOWED_HOSTS: BOX });
    try {
      assert.equal((await get("/context", { host: BOX })).status, 200, `/context on ${BOX}`);
      assert.equal((await get("/api/gtm/shell", { host: BOX })).status, 200, `/api/gtm/shell on ${BOX}`);
      const before = await runsCount();
      for (const headers of [{}, { origin: `https://${BOX}`, "sec-fetch-site": "same-origin" }]) {
        const r = await get(`/api/gtm/start/${workflow}`, { method: "POST", host: BOX, headers, body: { name: "box" } });
        assert.equal(r.status, 403, `start on ${BOX} ${JSON.stringify(headers)} → ${r.status}: ${r.text.slice(0, 300)}`);
      }
      if (s.runId) refused(await get(`/api/gtm/runs/${s.runId}`, { host: BOX }), `runs on ${BOX}`);
      assert.equal(await runsCount(), before);
      refused(await get("/context", { host: "evil.test" }), "evil.test still refused");
    } finally {
      await stopDev();
      await startDev();
    }
  });

  const stamp = () => sql(s.dir, s.dbUrl, "select value from gtm.meta where key = 'production'");
  const unstamp = () => sql(s.dir, s.dbUrl, "delete from gtm.meta where key = 'production'");

  await t.test("hosted-production gtm migrate refuses a pending DROP without `-- gtm: destructive` (and applies it with)", async () => {
    const journalRel = "db/migrations/meta/_journal.json";
    const journal = exists(journalRel) ? JSON.parse(read(journalRel)) : { version: "7", dialect: "postgresql", entries: [] };
    const last = journal.entries.at(-1);
    const idx = last ? last.idx + 1 : 0;
    const tag = `${String(idx).padStart(4, "0")}_acceptance_drop`;
    journal.entries.push({ idx, version: "7", when: Math.max(Date.now(), (last?.when ?? 0) + 1), tag, breakpoints: true });
    write(journalRel, JSON.stringify(journal, null, 2));
    const drop = 'DROP TABLE IF EXISTS "acceptance_scratch";\n';
    write(`db/migrations/${tag}.sql`, drop);
    const hosted = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test", NODE_ENV: "production", DATABASE_URL: s.dbUrl };
    const applied = async () => (await sql(s.dir, s.dbUrl, "select count(*)::int as n from drizzle.__drizzle_migrations"))[0].n;
    const n = await applied();
    const refusedRun = await gtm(["migrate"], { env: hosted });
    try {
      assert.notEqual(refusedRun.code, 0, `hosted migrate applied a DROP without the marker:\n${tail(refusedRun.output)}`);
      assert.match(refusedRun.output, /destructive/i);
      assert.equal(await applied(), n, "nothing applied");
      assert.deepEqual(await stamp(), [], "not stamped after refusing");
      write(`db/migrations/${tag}.sql`, `-- gtm: destructive\n${drop}`);
      assertOk(await gtm(["migrate"], { env: hosted }), "hosted migrate with the marker");
      assert.equal(await applied(), n + 1);
      assert.deepEqual(await stamp(), [{ value: "127.0.0.1" }], "hosted production migrate stamps");
    } finally {
      await unstamp();
    }
  });

  await t.test("a database stamped for its own identity is refused by db(), gtm migrate and gtm dev, also with VERCEL_ENV=production in .env.local",
    async () => {
      const envLocal = file(".env.local");
      const original = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, "utf8") : null;
      // db() as a script would use it: env files loaded like Next does, then one query.
      const viaDb = () => run("node", ["-e", `const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), false, { info() {}, error() {} }, true);
(async () => {
  const { db } = await import("@eliasstravik/gtm/db");
  const { sql } = await import("drizzle-orm");
  await db().execute(sql.raw("select 1"));
  console.log("db() query ran");
  process.exit(0);
})().catch((e) => { console.error(String(e?.message ?? e)); process.exit(3); });`], { cwd: s.dir, env: cleanEnv({ DATABASE_URL: s.dbUrl }), name: "node-db" });
      const expectRefused = (r, what) => {
        assert.notEqual(r.code, 0, `${what} accepted a production-stamped database:\n${tail(r.output)}`);
        assert.match(r.output, PRODUCTION_DB, what);
      };
      const devRefused = async (what) => {
        const proc = startProcess(bin(), ["dev"], { cwd: s.dir, env: cleanEnv({ GTM_PORT: String(PORT) }), name: "gtm-dev-stamped" });
        const exited = await within(proc.exited, 3 * MIN);
        const answered = await portOpen(PORT);
        await proc.stop();
        assert.ok(exited, `${what}: gtm dev kept running:\n${tail(proc.output)}`);
        assert.notEqual(proc.exitCode, 0, what);
        assert.match(proc.output, PRODUCTION_DB, what);
        assert.equal(answered, false, `${what}: something answered on ${PORT}`);
      };
      await sql(s.dir, s.dbUrl, "insert into gtm.meta (key, value) values ('production', $1) on conflict (key) do update set value = excluded.value",
        [new URL(s.dbUrl).hostname]);
      try {
        expectRefused(await viaDb(), "db()");
        expectRefused(await gtm(["migrate"]), "gtm migrate (gtm dev holding the database)");
        fs.appendFileSync(envLocal, "\nVERCEL_ENV=production\n");
        expectRefused(await viaDb(), "db() with VERCEL_ENV=production in .env.local");
        expectRefused(await gtm(["migrate"]), "gtm migrate with VERCEL_ENV=production in .env.local");
        await stopDev();
        await devRefused("gtm dev with VERCEL_ENV=production in .env.local");
        expectRefused(await gtm(["migrate"]), "gtm migrate (own short-lived server) with VERCEL_ENV=production in .env.local");
        if (original === null) fs.rmSync(envLocal); else fs.writeFileSync(envLocal, original);
        await devRefused("gtm dev");
        expectRefused(await gtm(["migrate"]), "gtm migrate (own short-lived server)");
      } finally {
        if (original === null) fs.rmSync(envLocal, { force: true }); else fs.writeFileSync(envLocal, original);
        await stopDev();
        // Nothing serves the database now (gtm refuses it), so remove the stamp straight from the PGlite folder.
        const lock = exists(".gtm/db.lock") ? JSON.parse(read(".gtm/db.lock")) : {};
        assertOk(await run("node", ["--input-type=module", "-e", `import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(process.argv[1]);
await db.query("delete from gtm.meta where key = 'production'");
await db.close();`, lock.dataDir ?? file(".gtm/pglite")], { cwd: s.dir, name: "unstamp" }), "remove the stamp");
      }
      assertOk(await gtm(["migrate"]), "gtm migrate after removing the stamp");
    });
});

test("7.7 re-running gtm init changes no company file except the managed block; restores proxy.ts, not company.md",
  { timeout: 30 * MIN }, async (t) => {
    if (!ready()) return t.skip("no project (7.1 failed)");
    await stopDev();
    // Company edits around the block, and an outdated block, so the refresh has something to do.
    const agents = read("AGENTS.md").replace(BLOCK, (b) => b.replace(/\n[^\n]*\n/, "\nan outdated line\n"));
    write("AGENTS.md", `# Acme notes\n\n${agents}\n## Company rules\n\nWe sell to mid-market SaaS.\n`);
    const check = await gtm(["check"]);
    assert.notEqual(check.code, 0, `gtm check should report the outdated managed block:\n${tail(check.output)}`);
    assert.match(check.output, /block|AGENTS\.md/i, "gtm check names the managed block");
    const before = snapshot(s.dir);
    const agentsBefore = read("AGENTS.md");
    assertOk(await init(), "gtm init (re-run)");
    const diff = diffSnapshots(before, snapshot(s.dir));
    assert.deepEqual(diff.added, [], "added");
    assert.deepEqual(diff.removed, [], "removed");
    assert.deepEqual(diff.changed, ["AGENTS.md"], "only AGENTS.md changes");
    const agentsAfter = read("AGENTS.md");
    assert.equal(agentsAfter.replace(BLOCK, "<block>"), agentsBefore.replace(BLOCK, "<block>"), "AGENTS.md outside the block");
    assert.equal(agentsAfter.match(BLOCK)?.[0], s.block, "the block is refreshed");
    assertOk(await gtm(["check"]), "gtm check after the refresh");

    const proxy = read("proxy.ts");
    const company = read("context/company.md");
    fs.rmSync(file("proxy.ts"));
    fs.rmSync(file("context/company.md"));
    assertOk(await init(), "gtm init (after deleting proxy.ts and context/company.md)");
    assert.equal(exists("proxy.ts") && read("proxy.ts"), proxy, "proxy.ts restored as it was");
    assert.equal(exists("context/company.md"), false, "context/company.md is not recreated");
    write("context/company.md", company);
  });

test("7.6 gtm init --slack: builds with withEve; only adds agent/** and the eve dependency; gtm dev stays on 127.0.0.1",
  { timeout: 40 * MIN }, async (t) => {
    if (!ready()) return t.skip("no project (7.1 failed)");
    await stopDev();
    const before = snapshot(s.dir);
    const pkgBefore = JSON.parse(read("package.json"));
    assertOk(await init(["--slack"]), "gtm init --slack");
    const diff = diffSnapshots(before, snapshot(s.dir));
    // Accepted deviation (lead): eve's discovery refuses non-skill entries, so --slack drops the empty folder's
    // .gitkeep placeholder from .agents/skills (which agent/skills links to). Nothing else may go.
    assert.deepEqual(diff.removed.filter((f) => f !== ".agents/skills/.gitkeep"), [], "removed");
    assert.deepEqual(diff.changed.filter((f) => f !== "package.json" && f !== "package-lock.json"), [], "changed besides package.json");
    assert.deepEqual(diff.added.filter((f) => f !== "agent" && !f.startsWith("agent/")), [], "added outside agent/");
    assert.ok(diff.added.includes("agent"), "agent/ added");
    const pkgAfter = JSON.parse(read("package.json"));
    const peer = JSON.parse(read("node_modules/@eliasstravik/gtm/package.json")).peerDependencies.eve;
    assert.equal(pkgAfter.dependencies?.eve, peer, "eve added at the package's pinned peer version");
    delete pkgAfter.dependencies.eve;
    assert.deepEqual(pkgAfter, pkgBefore, "package.json changes only by the eve dependency");
    assert.ok(exists("node_modules/eve/package.json"), "eve installed");

    assertOk(await npm(["run", "build"]), "npm run build with agent/");
    // withEve's mark on a local build: its /eve/v1/* rewrite in the routes manifest.
    const { rewrites } = JSON.parse(read(".next/routes-manifest.json"));
    const eve = [rewrites?.beforeFiles ?? [], rewrites?.afterFiles ?? [], rewrites?.fallback ?? [], Array.isArray(rewrites) ? rewrites : []].flat()
      .filter((r) => String(r.source).startsWith("/eve/v1"));
    assert.ok(eve.length, `the build did not apply withEve (no /eve/v1 rewrite): ${JSON.stringify(rewrites)}`);

    await startDev();
    try {
      // Reaching eve makes it start whatever it starts; deny-all auth should refuse the call.
      const session = await get("/eve/v1/session", { method: "POST", body: {} }).catch((e) => ({ status: e.message, text: "" }));
      t.diagnostic(`POST /eve/v1/session (no credentials): ${session.status} ${session.text.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 5000));
      const sockets = devSockets();
      t.diagnostic(`listening: ${sockets.map((x) => x.local).join(" ")}`);
      assertLoopbackOnly(sockets);
    } finally {
      await stopDev();
    }
    // A local `next build` does not compile agent/ (eve builds it on Vercel). Report eve's own build; never fail on it.
    const eveBuild = await run(file("node_modules/.bin/eve"), ["build", "--skip-sandbox-prewarm"], { cwd: s.dir, name: "eve-build", timeout: 10 * MIN });
    t.diagnostic(`eve build --skip-sandbox-prewarm: exit ${eveBuild.code} (log ${eveBuild.log})${eveBuild.code ? `\n${tail(eveBuild.output, 1500)}` : ""}`);
  });
