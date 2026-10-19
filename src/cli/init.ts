import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isGtmProject, packageRoot, readJson, RESTORED, SKILLS_TARGET, skillLinks, withBlock } from "./project.js";

/** Entries a folder may already hold and still count as empty (plan §3). */
const EMPTY_OK = new Set([".git", ".agents", ".claude", "AGENTS.md", "CLAUDE.md"]);
/** Starter paths init writes itself instead of copying them verbatim. */
const SPECIAL = new Set(["gitignore", ".gitignore", "package.json", "AGENTS.md", "CLAUDE.md", ".claude/skills", "node_modules", ".next"]);
/** The eve version `--slack` adds (the package's optional peer). */
const EVE = "0.80.1";

/**
 * `gtm init [dir] [--slack] [--package <spec>] [--no-install]`: copies the starter into an empty folder, or repairs
 * an existing gtm project (restores missing wiring and refreshes the AGENTS.md block, nothing else).
 * `--package` (or GTM_PACKAGE_SPEC) replaces the @eliasstravik/gtm dependency spec; it and `--no-install` are for tests.
 */
export async function init(args: string[]): Promise<void> {
  const options = { slack: { type: "boolean" }, package: { type: "string" }, "no-install": { type: "boolean" } } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (positionals.length > 1) throw new Error("Usage: gtm init [dir] [--slack]");
  const dir = resolve(positionals[0] ?? ".");
  const starter = join(packageRoot(), "starter");
  const fresh = !isGtmProject(dir);
  const repaired = fresh ? [] : repair(dir, starter);
  if (fresh) create(dir, starter, values.package ?? process.env.GTM_PACKAGE_SPEC);
  const addedEve = values.slack ? addSlack(dir) : false;
  if (fresh || addedEve || !existsSync(join(dir, "node_modules"))) {
    if (values["no-install"]) console.log("Skipped npm install (--no-install).");
    else install(dir);
  }
  const rel = relative(process.cwd(), dir) || ".";
  console.log(fresh ? `\nCreated a gtm project in ${rel}.`
    : `\n${rel} is already a gtm project: ${repaired.join("; ") || "nothing to restore, AGENTS.md block current"}.`);
  if (values.slack) console.log("agent/ holds the Slack agent template (existing files kept); see `npx @eliasstravik/gtm docs slack`.");
  console.log(`Next:${rel === "." ? "" : `\n  cd ${rel}`}
  npm run dev                    cockpit on http://127.0.0.1:3000
  npx @eliasstravik/gtm check    problems with their fixes
  then fill in context/company.md`);
}

function refuseNonEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  const pkg = readJson(join(dir, "package.json"));
  if (pkg?.dependencies?.next || pkg?.devDependencies?.next || readdirSync(dir).some((f) => f.startsWith("next.config.")))
    throw new Error(`${dir} is an existing Next.js app; adding gtm to one is not supported in 0.0.1. Run init in a new folder.`);
  const extra = readdirSync(dir).filter((name) => !EMPTY_OK.has(name));
  if (extra.length) throw new Error(`${dir} is not empty (${extra.slice(0, 5).join(", ")}). Run init in an empty folder or a gtm project.`);
  const [claude, agents] = [join(dir, ".claude", "skills"), join(dir, ".agents", "skills")];
  const clash = existsSync(claude) && existsSync(agents) ? readdirSync(claude).filter((n) => n !== ".gitkeep" && existsSync(join(agents, n))) : [];
  if (clash.length) throw new Error(`.claude/skills and .agents/skills both hold ${clash.join(", ")}; merge them by hand, then run init again.`);
}

function create(dir: string, starter: string, spec: string | undefined): void {
  refuseNonEmpty(dir);
  mkdirSync(dir, { recursive: true });
  const rel = (src: string) => relative(starter, src).split(sep).join("/");
  cpSync(starter, dir, { recursive: true, force: false, errorOnExist: false, filter: (src) => !SPECIAL.has(rel(src)) });
  writeFileSync(join(dir, ".gitignore"), readFileSync(join(starter, "gitignore")), { flag: "wx" });
  const agents = join(dir, "AGENTS.md");
  if (existsSync(agents)) writeFileSync(agents, withBlock(readFileSync(agents, "utf8")));
  else cpSync(join(starter, "AGENTS.md"), agents);
  const claude = join(dir, "CLAUDE.md");
  const text = existsSync(claude) ? readFileSync(claude, "utf8") : "";
  if (!/^@AGENTS\.md\s*$/m.test(text)) writeFileSync(claude, `@AGENTS.md\n${text ? `\n${text}` : ""}`);
  const pkg = readJson(join(starter, "package.json"));
  pkg.name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || pkg.name;
  pkg.dependencies["@eliasstravik/gtm"] = spec ?? `^${readJson(join(packageRoot(), "package.json")).version}`;
  writeJson(join(dir, "package.json"), pkg);
  for (const link of skillLinks(dir)) linkSkills(dir, link, true);
  // Claude Code sets CLAUDECODE=1; Codex sets CODEX_THREAD_ID (checked first: Codex may run inside Claude Code).
  const backend = process.env.CODEX_THREAD_ID ? "codex" : process.env.CLAUDECODE === "1" ? "claude" : undefined;
  if (backend) writeFileSync(join(dir, ".env.local"), `GTM_AGENT_BACKEND=${backend}\n`, { flag: "wx" });
}

/** Restores only the wiring files and links that are missing, and refreshes the managed block. Returns what it did. */
function repair(dir: string, starter: string): string[] {
  const restored: string[] = [];
  for (const file of [...RESTORED, ".gitignore"]) {
    if (existsSync(join(dir, file))) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(starter, file === ".gitignore" ? "gitignore" : file), join(dir, file));
    restored.push(file);
  }
  mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
  for (const link of skillLinks(dir)) if (linkSkills(dir, link, false)) restored.push(link);
  const agents = join(dir, "AGENTS.md");
  const before = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  const after = withBlock(before);
  if (after !== before) writeFileSync(agents, after);
  return [...(restored.length ? [`restored ${restored.join(", ")}`] : []), ...(after !== before ? ["refreshed the AGENTS.md block"] : [])];
}

/**
 * Links `rel` to .agents/skills (copies when symlinks fail). With `merge` (new projects), an existing folder there
 * is folded into .agents/skills first (refuseNonEmpty has ruled out clashes); otherwise anything already there is
 * left alone. Returns whether it wrote.
 */
function linkSkills(dir: string, rel: string, merge: boolean): boolean {
  const path = join(dir, rel);
  const skills = join(dir, ".agents", "skills");
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && (!merge || (st.isSymbolicLink() && readlinkSync(path) === SKILLS_TARGET))) return false;
  if (st && existsSync(path)) cpSync(path, skills, { recursive: true, force: false, errorOnExist: false, dereference: true });
  if (st) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  try {
    symlinkSync(SKILLS_TARGET, path, "dir");
  } catch {
    cpSync(skills, path, { recursive: true });
    console.warn(`Could not create the symlink ${rel}; copied .agents/skills there instead. Keep the copy in sync.`);
  }
  return true;
}

/** `--slack`: adds the agent/ template files (never overwriting) and the eve dependency. True when package.json changed. */
function addSlack(dir: string): boolean {
  const template = join(packageRoot(), "slack", "agent");
  if (!existsSync(template)) throw new Error("This version of @eliasstravik/gtm ships no Slack agent template.");
  cpSync(template, join(dir, "agent"), { recursive: true, force: false, errorOnExist: false, filter: (src) => relative(template, src) !== "skills" });
  linkSkills(dir, "agent/skills", false);
  // eve loads every entry of agent/skills as a skill and refuses `.gitkeep`; a missing or empty folder is fine.
  rmSync(join(dir, ".agents", "skills", ".gitkeep"), { force: true });
  const pkg = readJson(join(dir, "package.json"));
  if (pkg.dependencies?.eve) return false;
  pkg.dependencies = Object.fromEntries(Object.entries({ ...pkg.dependencies, eve: EVE }).sort(([a], [b]) => a.localeCompare(b)));
  writeJson(join(dir, "package.json"), pkg);
  return true;
}

function install(dir: string): void {
  const result = spawnSync("npm", ["install"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("npm install failed; fix the error above, then run `npm install` in the project.");
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
