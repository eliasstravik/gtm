/**
 * `gtm init`'s folder choice, against the built CLI (`npm run build` first) with --no-install: no network, seconds.
 * The full init → build → check path is acceptance check 7.1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "gtm-init-"));
after(() => fs.rmSync(work, { recursive: true, force: true }));

/** Runs `gtm init …` in `cwd` with stdin not a terminal, as an agent or CI runs it. */
function init(args, cwd = work) {
  const r = spawnSync("node", [CLI, "init", ...args, "--no-install"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}
const read = (...rel) => fs.readFileSync(path.join(work, ...rel), "utf8");

test("with --company and no folder it creates ./gtm-<company>, named in package.json and context/company.md", () => {
  const r = init(["--company", "Café Acme & Co"]);
  assert.equal(r.code, 0, r.output);
  assert.equal(JSON.parse(read("gtm-cafe-acme-co", "package.json")).name, "gtm-cafe-acme-co");
  assert.match(read("gtm-cafe-acme-co", "context", "company.md"), /^# Café Acme & Co$/m);
  assert.match(r.output, /cd gtm-cafe-acme-co/);
});

test("the company name is written as given, $ patterns included", () => {
  const r = init(["custom-dollar", "--company", "Acme $& Co $1"]);
  assert.equal(r.code, 0, r.output);
  assert.match(read("custom-dollar", "context", "company.md"), /^# Acme \$& Co \$1$/m);
});

test("a company already named gtm-… is not doubled", () => {
  assert.equal(init(["--company", "gtm-acme"]).code, 0);
  assert.ok(fs.existsSync(path.join(work, "gtm-acme", "package.json")));
});

test("a given folder wins over the default name", () => {
  const r = init(["custom", "--company", "Globex"]);
  assert.equal(r.code, 0, r.output);
  assert.equal(JSON.parse(read("custom", "package.json")).name, "custom");
  assert.match(read("custom", "context", "company.md"), /^# Globex$/m);
});

test("with no folder and no company, off a terminal, it names the flag instead of guessing", () => {
  const empty = fs.mkdtempSync(path.join(work, "empty-"));
  const r = init([], empty);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /--company Acme creates \.\/gtm-acme/);
  assert.deepEqual(fs.readdirSync(empty), [], "nothing written");
});

test("with no folder inside a gtm project it repairs that project, --company or not", () => {
  const project = path.join(work, "gtm-acme");
  fs.rmSync(path.join(project, "proxy.ts"));
  const r = init(["--company", "Acme"], project);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /already a gtm project: restored proxy\.ts/);
  assert.equal(fs.existsSync(path.join(project, "gtm-acme")), false, "no project inside the project");
});

/** Every file under `dir`, relative, sorted (node_modules and .git skipped). */
function files(dir, prefix = "") {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(prefix, e.name);
    if (e.name === "node_modules" || e.name === ".git") return [];
    return e.isDirectory() && !e.isSymbolicLink() ? files(dir, rel) : [rel];
  }).sort();
}

test("by default init writes the base files only: no workflows, tables, migrations or context beyond company.md", () => {
  assert.equal(init(["--company", "Plain"]).code, 0);
  const dir = path.join(work, "gtm-plain");
  const all = files(dir);
  assert.deepEqual(all.filter((f) => f.startsWith("context/")), ["context/company.md"]);
  assert.deepEqual(all.filter((f) => f.startsWith("workflows/")), ["workflows/index.ts"]);
  assert.deepEqual(all.filter((f) => f.startsWith("db/migrations/")), ["db/migrations/.gitkeep"]);
  assert.match(read("gtm-plain", "workflows", "index.ts"), /export const workflows = \{\} satisfies Registry;/);
  assert.match(read("gtm-plain", "db", "schema.ts"), /^export \{\};$/m);
  assert.equal(all.some((f) => /example/i.test(f) && f !== ".env.example"), false, `example files: ${all.filter((f) => /example/i.test(f))}`);
});

test("--example adds one marked example: workflow, table with its migration, and a context file", () => {
  const r = init(["--company", "Demo", "--example"]);
  assert.equal(r.code, 0, r.output);
  const all = files(path.join(work, "gtm-demo"));
  for (const f of ["workflows/example-import.ts", "context/example-icp.md", "db/migrations/0000_example_companies.sql", "db/migrations/meta/_journal.json"])
    assert.ok(all.includes(f), f);
  assert.match(read("gtm-demo", "workflows", "index.ts"), /"example-import"/);
  assert.match(read("gtm-demo", "db", "schema.ts"), /example_companies/);
  assert.match(read("gtm-demo", "context", "example-icp.md"), /^# Example ICP/m);
  assert.match(read("gtm-demo", "workflows", "example-import.ts"), /To remove the example/);
  assert.match(read("gtm-demo", "context", "company.md"), /^# Demo$/m, "company.md stays the base one");
});

test("--example on an existing project is refused and changes nothing", () => {
  const before = files(path.join(work, "gtm-plain"));
  const r = init(["gtm-plain", "--example"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /--example is only for a new one/);
  assert.deepEqual(files(path.join(work, "gtm-plain")), before);
});
