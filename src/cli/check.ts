import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { assertNotProduction, databaseIdentity, PRODUCTION_DATABASE, value } from "../shared/env.js";
import { extractBlock, findProject, loadEnv, managedBlock, packageRoot, readJson, RESTORED, skillLinks } from "./project.js";

type Report = { problems: string[]; warnings: string[]; info: string[] };

const INIT = "run `npx @eliasstravik/gtm init` in the project";
const LAYOUT = "recreate it as the starter has it (`npx @eliasstravik/gtm docs layout`)";
/** Files the layout needs besides the ones `gtm init` restores. */
const REQUIRED = ["package.json", "AGENTS.md", "CLAUDE.md", "next.config.ts", "app/layout.tsx", "context", "db/schema.ts",
  "drizzle.config.ts", ".env.example", "vercel.json", ".agents/skills"];
/** [file, text it must contain, fix]. */
const CONTAINS: [string, string, string][] = [
  ["CLAUDE.md", "@AGENTS.md", "add the line `@AGENTS.md` so Claude Code reads AGENTS.md"],
  ["next.config.ts", "withGtm(", "export the config wrapped in withGtm() from @eliasstravik/gtm/next"],
  ["proxy.ts", "gtmProxy(", "return gtmProxy(req) from its default export, as the starter's proxy.ts does"],
  ["app/api/gtm/[...path]/route.ts", "gtm({", "export { GET, POST } from gtm({ workflows }), as the starter's route does"],
  ["public/_gtm/probe.txt", "gtm-probe-v1", "make `gtm-probe-v1` its only contents"],
  [".gitignore", ".env*.local", "add `.env*.local` (those files hold keys)"],
];

/** `gtm check [--prod]`: read-only report. Exits non-zero when there are problems; each comes with its fix. */
export async function check(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { prod: { type: "boolean" } } });
  const shellToken = process.env.VERCEL_TOKEN; // only the shell's, never one from env files
  const dir = findProject();
  loadEnv(dir, true);
  const r: Report = { problems: [], warnings: [], info: [] };
  layout(dir, r);
  registry(dir, r);
  const names = [...(read(dir, ".env.example") ?? "").matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]);
  r.info.push(`Connections (.env.example):${names.length ? "" : " none listed"}`, ...names.map((n) => `  ${n}: ${value(n) ? "set" : "missing"} here`));
  const link = readJson(join(dir, ".vercel", "project.json"));
  r.info.push(link?.projectId ? `Vercel: linked (project ${link.projectId})` : "Vercel: not linked");
  await database(dir, r);
  if (values.prod) await prod(link, shellToken, r);
  console.log(`gtm check: ${dir}`);
  for (const p of r.problems) console.log(`\nPROBLEM: ${p}`);
  for (const w of r.warnings) console.log(`\nWARNING: ${w}`);
  console.log(`\n${r.info.join("\n")}\n\n${r.problems.length ? `${r.problems.length} problem(s).` : "No problems."}`);
  if (r.problems.length) process.exitCode = 1;
}

function problem(r: Report, what: string, fix: string): void {
  r.problems.push(`${what}\n  Fix: ${fix}.`);
}

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

const sameFile = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const matcher = (src: string) => /matcher\s*:\s*(\[[^\]]*\])/.exec(src)?.[1].replace(/\s+/g, "").replace(/'/g, '"');

function layout(dir: string, r: Report): void {
  for (const file of [...RESTORED, ".gitignore"]) if (!existsSync(join(dir, file))) problem(r, `${file} is missing.`, `${INIT} to restore it`);
  for (const file of REQUIRED) if (!existsSync(join(dir, file))) problem(r, `${file} is missing.`, LAYOUT);
  for (const [file, text, fix] of CONTAINS) {
    const src = read(dir, file);
    if (src != null && !src.includes(text)) problem(r, `${file} does not contain \`${text}\`.`, fix);
  }
  for (const link of skillLinks(dir)) {
    const path = join(dir, link);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) problem(r, `${link} is missing.`, `${INIT} to recreate the link`);
    else if (!st.isSymbolicLink()) r.warnings.push(`${link} is a copy of .agents/skills (symlinks failed here); copy .agents/skills over it after every skill change.`);
    else if (!sameFile(path, join(dir, ".agents", "skills")))
      problem(r, `${link} does not point at .agents/skills.`, `delete it and ${INIT}`);
  }
  const agents = read(dir, "AGENTS.md");
  const block = agents == null ? undefined : extractBlock(agents);
  if (agents != null && block !== managedBlock())
    problem(r, block ? "The managed gtm block in AGENTS.md is outdated." : "AGENTS.md has no managed gtm block.", `${INIT} to refresh it`);
  const proxy = read(dir, "proxy.ts");
  const want = matcher(readFileSync(join(packageRoot(), "starter", "proxy.ts"), "utf8"));
  if (proxy != null && matcher(proxy) !== want) problem(r, "proxy.ts's matcher differs from the starter's.", `set it back to \`matcher: ${want}\``);
}

/** workflows/index.ts must exist, export `workflows`, and every import in it must resolve. */
function registry(dir: string, r: Report): void {
  const src = read(dir, "workflows/index.ts");
  const fix = "export const workflows = { <name>: workflowFn } (`npx @eliasstravik/gtm docs workflows`)";
  if (src == null) return problem(r, "workflows/index.ts is missing.", `recreate it: ${fix}`);
  if (!/export\s+(?:const|let|var)\s+workflows\b|export\s*\{[^}]*\bworkflows\b/.test(src)) problem(r, "workflows/index.ts does not export `workflows`.", fix);
  for (const [, spec] of src.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g))
    if (!resolves(dir, spec)) problem(r, `workflows/index.ts imports "${spec}", which does not resolve.`, "fix the path, create the file, or `npm install` the package");
}

function resolves(dir: string, spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  if (!spec.startsWith(".") && !spec.startsWith("@/")) {
    return existsSync(join(dir, "node_modules", spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")));
  }
  const base = spec.startsWith("@/") ? join(dir, spec.slice(2)) : resolve(dir, "workflows", spec);
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  const candidates = [base, ...["", "/index"].flatMap((s) => [".ts", ".tsx", ".mts", ".js", ".mjs"].map((e) => stem + s + e))];
  return candidates.some((p) => existsSync(p) && statSync(p).isFile());
}

async function database(dir: string, r: Report): Promise<void> {
  const local = !value("DATABASE_URL");
  try {
    const { withDatabase } = await import("./localdb.js");
    const url = await withDatabase(dir, async (url: string) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await assertNotProduction(async (sql) => (await client.query(sql)).rows, url);
      } finally {
        await client.end();
      }
      return url;
    });
    r.info.push(`Database: ${databaseIdentity(url)}${local ? " (local PGlite in .gtm/)" : ""}`);
    if (!local) return void r.info.push(`DATABASE_URL: ${redact(url)} (from env files)`);
    // The URL is stable only when `gtm dev` serves it; a short-lived server's lock is gone by now.
    const lock = readJson(join(dir, ".gtm", "db.lock"));
    const live = lock?.dev && lock.port === Number(new URL(url).port) && alive(lock.pid);
    r.info.push(live ? `DATABASE_URL: ${url} (served by \`gtm dev\` while it runs)` : "DATABASE_URL: the local database has a URL only while `npm run dev` runs; run check again then to print it");
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (message.includes(PRODUCTION_DATABASE)) problem(r, "The database is stamped as production's.", "point DATABASE_URL at a dev branch (`npx @eliasstravik/gtm docs data`)");
    else problem(r, `The database is unreachable: ${message}`, local ? "see `npx @eliasstravik/gtm docs local`" : "check DATABASE_URL in your env files");
  }
}

function alive(pid: unknown): boolean {
  try {
    return typeof pid === "number" && process.kill(pid, 0);
  } catch {
    return false;
  }
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "****";
  return u.toString();
}

/** `--prod`: production answers with Vercel's login, and the project has no protection holes. */
async function prod(link: { projectId?: string; orgId?: string } | undefined, shellToken: string | undefined, r: Report): Promise<void> {
  const url = value("GTM_PRODUCTION_URL");
  if (!url) problem(r, "GTM_PRODUCTION_URL is not set.", "add it to .env.local (`npx @eliasstravik/gtm docs deploy`)");
  else {
    const res = await fetch(new URL(url.includes("://") ? url : `https://${url}`), { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
    const location = res instanceof Response ? res.headers.get("location") ?? "" : "";
    if (!(res instanceof Response)) problem(r, `${url} is unreachable: ${res.message}`, "check GTM_PRODUCTION_URL");
    else if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && location.startsWith("https://vercel.com/sso-api")))
      r.info.push(`Production: ${url} answers with Vercel's login`);
    else problem(r, `${url} answers ${res.status} without Vercel's login.`, "turn on Vercel Authentication → All Deployments (`npx @eliasstravik/gtm docs deploy`)");
  }
  if (!link?.projectId) return problem(r, "This folder is not linked to a Vercel project.", "run `vercel link`");
  const api = vercelApi(shellToken);
  if (!api) return problem(r, "No Vercel credentials to read the project's protection settings.", "set VERCEL_TOKEN in the shell or run `vercel login`");
  const query = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(link.orgId?.startsWith("team_") ? { teamId: link.orgId } : {}), ...extra }).toString();
  try {
    const project = await api(`/v9/projects/${link.projectId}?${query()}`);
    const aliases: unknown[] = [];
    for (let page = 0, until: string | undefined; page < 20; page += 1) {
      const body = await api(`/v4/aliases?${query({ projectId: project.id ?? link.projectId, limit: "100", ...(until ? { until } : {}) })}`);
      aliases.push(...(body.aliases ?? []));
      until = body.pagination?.next == null ? undefined : String(body.pagination.next);
      if (!until) break;
    }
    const found = protectionFindings(project, aliases);
    for (const [what, fix] of found.problems) problem(r, what, fix);
    r.info.push(...found.info);
  } catch (error) {
    problem(r, `The Vercel API refused: ${(error as Error).message}`, "check the token or `vercel login`, and that it can read this project");
  }
}

/**
 * The Vercel field checks (confirmed by spike 1d). Problems: `ssoProtection.deploymentType` other than "all" (All
 * Deployments); alias `protectionBypass` entries with scope "alias-protection-override" (a Deployment Protection
 * Exception), "shareable-link", or "user" with access "granted" (an approved access request). Info: the project's
 * automation bypasses by note. Bypass map keys are secrets: only alias names and notes are ever reported.
 */
export function protectionFindings(project: any, aliases: any[]): { problems: [string, string][]; info: string[] } {
  const problems: [string, string][] = [];
  const type = project?.ssoProtection?.deploymentType ?? null;
  if (type !== "all")
    problems.push([`Vercel Authentication is ${type ? `"${type}"` : "off"}, not All Deployments.`, "Project Settings → Deployment Protection → Vercel Authentication → All Deployments"]);
  for (const alias of aliases) {
    for (const bypass of Object.values<any>(alias?.protectionBypass ?? {})) {
      if (bypass?.scope === "alias-protection-override")
        problems.push([`${alias.alias} has a Deployment Protection Exception.`, "remove it under Deployment Protection → Deployment Protection Exceptions"]);
      if (bypass?.scope === "shareable-link") problems.push([`${alias.alias} has a Shareable Link.`, "revoke it under Deployment Protection → Shareable Links"]);
      if (bypass?.scope === "user" && bypass.access === "granted")
        problems.push([`${alias.alias} has an approved access request.`, "revoke it in the Vercel dashboard; invite teammates as Viewers instead"]);
    }
  }
  const notes = Object.values<any>(project?.protectionBypass ?? {}).filter((b) => b?.scope === "automation-bypass").map((b) => b.note || "(no note)");
  const info = [`Automation bypass secrets: ${notes.length ? notes.join(", ") : "none"}`,
    "Links shared on bare deployment URLs cannot be listed through Vercel's API (the proxy refuses their bypass cookie)"];
  return { problems, info };
}

/** GET against the Vercel API with VERCEL_TOKEN from the shell, else the logged-in `vercel` CLI's session. */
function vercelApi(shellToken: string | undefined): ((path: string) => Promise<any>) | undefined {
  let token = shellToken;
  let base = "https://api.vercel.com";
  if (!token) {
    const home = homedir();
    const dirs = [process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, "com.vercel.cli"), join(home, ".local", "share", "com.vercel.cli"),
      join(home, "Library", "Application Support", "com.vercel.cli"), process.env.APPDATA && join(process.env.APPDATA, "com.vercel.cli", "Data")];
    const found = dirs.find((d): d is string => Boolean(d) && existsSync(join(d as string, "auth.json")));
    if (!found) return undefined;
    token = readJson(join(found, "auth.json"))?.token;
    base = readJson(join(found, "config.json"))?.api ?? base; // the CLI's own API base, when configured
  }
  if (!token) return undefined;
  return async (path) => {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} on ${path.split("?")[0]}`);
    return res.json();
  };
}
