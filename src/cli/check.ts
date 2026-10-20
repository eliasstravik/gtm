import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { assertNotProduction, databaseIdentity, PRODUCTION_DATABASE, value } from "../shared/env.js";
import { alive, withDatabase } from "./localdb.js";
import { extractBlock, findProject, loadEnv, managedBlock, packageRoot, readJson, RESTORED, SKILLS_TARGET, skillLinks } from "./project.js";

type Report = { problems: string[]; warnings: string[]; info: string[] };

const INIT = "run `npx @eliasstravik/gtm init` in the project";
const LAYOUT = "recreate it as the starter has it (`npx @eliasstravik/gtm docs layout`)";
/** Files the layout needs besides the ones `gtm init` restores. */
const REQUIRED = ["package.json", "AGENTS.md", "CLAUDE.md", "next.config.ts", "app/layout.tsx", "context", "db/schema.ts",
  "drizzle.config.ts", ".env.example", "vercel.json"];
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
  for (const [what, fix] of aiRule(workflowCode(dir))) problem(r, what, fix);
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

const read = (dir: string, file: string) => { try { return readFileSync(join(dir, file), "utf8"); } catch { return undefined; } };

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
    else if (readlinkSync(path) !== SKILLS_TARGET) problem(r, `${link} does not point at .agents/skills.`, `delete it and ${INIT}`);
  }
  // A Slack project drops .gitkeep (eve loads every entry of agent/skills as a skill), so git keeps no empty folder.
  const slack = existsSync(join(dir, "agent"));
  if (!slack && !existsSync(join(dir, ".agents", "skills"))) problem(r, ".agents/skills is missing.", LAYOUT);
  if (slack && existsSync(join(dir, ".agents", "skills", ".gitkeep")))
    problem(r, ".agents/skills/.gitkeep breaks the Slack agent (eve loads every entry there as a skill).", "delete it");
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
  const raw = read(dir, "workflows/index.ts");
  const fix = "export const workflows = { <name>: workflowFn } (`npx @eliasstravik/gtm docs workflows`)";
  if (raw == null) return problem(r, "workflows/index.ts is missing.", `recreate it: ${fix}`);
  const src = mask(raw);
  if (!/export\s+(?:const|let|var)\s+workflows\b|export\s*\{[^}]*\bworkflows\b/.test(src.code)) problem(r, "workflows/index.ts does not export `workflows`.", fix);
  for (const spec of specifiers(src, /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?["']/g))
    if (!resolves(dir, spec)) problem(r, `workflows/index.ts imports "${spec}", which does not resolve.`, "fix the path, create the file, or `npm install` the package");
}

/**
 * src with comments blanked (`text`), and with the contents of strings, template literals and regex literals blanked
 * too (`code`), so a pattern matched on `code` is real code. Blanks are spaces, so offsets and lines stay put.
 */
export function mask(src: string): { text: string; code: string } {
  const n = src.length, text = src.split(""), code = src.split("");
  const blank = (to: string[][], from: number, end: number) => { for (const a of to) for (let k = from; k < end; k++) if (a[k] !== "\n") a[k] = " "; };
  const open: number[] = []; // the brace depth at each template literal's `${`, to find the `}` that resumes it
  let depth = 0, regex = true, i = 0; // regex: a `/` here starts a regex literal, not a division
  /** Skips quoted text from `from` until `stop` says it ends (or the source does), blanking it in `code`. */
  const skip = (from: number, stop: (j: number) => boolean) => {
    let j = from;
    while (j < n && !stop(j)) j += src[j] === "\\" ? 2 : 1;
    blank([code], from, Math.min(j, n));
    return j;
  };
  /** A template literal's text from `from` to its end or its next `${`. */
  const template = (from: number) => {
    const j = skip(from, (k) => src[k] === "`" || (src[k] === "$" && src[k + 1] === "{"));
    regex = src[j] === "$";
    if (regex) open.push(depth);
    return j + (regex ? 2 : 1);
  };
  const WORD = /[\w$]+/y;
  while (i < n) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const line = src[i + 1] === "/", stop = line ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      const end = stop < 0 ? n : line ? stop : stop + 2;
      blank([text, code], i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      i = skip(i + 1, (k) => src[k] === c || src[k] === "\n") + 1;
      regex = false;
    } else if (c === "`") i = template(i + 1);
    else if (c === "/" && regex) {
      let j = i + 1, cls = false; // cls: inside [...], where `/` does not end the regex
      for (; j < n && src[j] !== "\n" && (cls || src[j] !== "/"); j += 1) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
      }
      blank([code], i + 1, Math.min(j, n));
      i = j + 1;
      regex = false;
    } else if (c === "}" && open.at(-1) === depth) {
      open.pop();
      i = template(i + 1);
    } else if (/[\w$]/.test(c)) {
      WORD.lastIndex = i;
      const word = WORD.exec(src)![0];
      regex = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word);
      i += word.length;
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      if (!/\s/.test(c)) regex = c !== ")" && c !== "]" && c !== "}";
      i += 1;
    }
  }
  return { text: text.join(""), code: code.join("") };
}

/** The module each match of `pattern` (on `code`, ending at a string's opening quote) names, read from `text`. */
function specifiers({ text, code }: { text: string; code: string }, pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map((m) => {
    const start = m.index + m[0].length;
    return text.slice(start, text.indexOf(m[0].at(-1)!, start));
  });
}

/** An import, import() or require() up to its module's opening quote; AI_MODULE tests the module. */
const AI_IMPORT = /(?:^|[\s;])(?:import(?!\s+type\b)\s*(?:[^'";]*?\sfrom\s*)?|import\s*\(\s*|require\s*\(\s*)["']/g;
const AI_MODULE = /^(?:ai|@ai-sdk\/[^"'/]+)(?:\/[^"']*)?$/;
/** A Gateway-style id or a bare provider id in quotes, except as a stage's own `model:`. */
const MODEL_ID = /(\bmodel\s*:\s*)?["'`]((?:anthropic|openai|google|xai|mistral|meta|deepseek|groq|perplexity|cohere|bedrock|vertex|amazon|alibaba|moonshotai|zai)\/[\w.:-]+|(?:claude|gpt|gemini)-[\w.-]+)["'`]/g;

/** Every AI call in a workflow is agent(): no AI SDK imports and no model ids in workflows/ (GTM_MODEL picks the model). */
export function aiRule(files: [string, string][]): [string, string][] {
  const found: [string, string][] = [];
  const fix = "call agent() from @eliasstravik/gtm/ai for every AI call, one-shot (no tools) or tool-using; custom tools take `tool` from there too (`npx @eliasstravik/gtm docs workflows`)";
  for (const [file, raw] of files) {
    const src = mask(raw); // comments, and for imports also strings, are not code
    for (const spec of specifiers(src, AI_IMPORT)) if (AI_MODULE.test(spec)) found.push([`${file} imports "${spec}".`, fix]);
    for (const [, own, id] of src.text.matchAll(MODEL_ID)) if (!own) found.push([`${file} names the model "${id}".`,
      "remove it; GTM_MODEL picks the model, and a stage that truly needs another one sets agent()'s `model`"]);
  }
  return found;
}

function workflowCode(dir: string): [string, string][] {
  const files = (() => { try { return readdirSync(join(dir, "workflows"), { recursive: true }) as string[]; } catch { return []; } })();
  return files.filter((f) => /\.[cm]?[jt]sx?$/.test(f)).map((f) => [`workflows/${f.split(sep).join("/")}`, read(dir, join("workflows", f)) ?? ""]);
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
    const url = await withDatabase(dir, async (url: string) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await assertNotProduction(async (sql) => (await client.query(sql)).rows, url).finally(() => client.end());
      return url;
    });
    r.info.push(`Database: ${databaseIdentity(url)}${local ? " (local PGlite in .gtm/)" : ""}`);
    if (!local) return; // a DATABASE_URL from env files is the person's own; its identity above is enough
    // The URL is stable only when `gtm dev` serves it; a short-lived server's lock is gone by now.
    const lock = readJson(join(dir, ".gtm", "db.lock"));
    const live = lock?.dev && lock.port === Number(new URL(url).port) && typeof lock.pid === "number" && alive(lock.pid);
    r.info.push(live ? `DATABASE_URL: ${url} (served by \`gtm dev\` while it runs)` : "DATABASE_URL: the local database has a URL only while `npm run dev` runs; run check again then to print it");
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (message.includes(PRODUCTION_DATABASE)) problem(r, "The database is stamped as production's.", "point DATABASE_URL at a dev branch (`npx @eliasstravik/gtm docs data`)");
    else problem(r, `The database is unreachable: ${message}`, local ? "see `npx @eliasstravik/gtm docs local`" : "check DATABASE_URL in your env files");
  }
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
  const home = homedir(), { XDG_DATA_HOME: xdg, APPDATA: appData } = process.env;
  const dirs = [xdg && join(xdg, "com.vercel.cli"), join(home, ".local", "share", "com.vercel.cli"),
    join(home, "Library", "Application Support", "com.vercel.cli"), appData && join(appData, "com.vercel.cli", "Data")];
  const found = shellToken ? undefined : dirs.find((d): d is string => Boolean(d) && existsSync(join(d as string, "auth.json")));
  const token = shellToken || (found && readJson(join(found, "auth.json"))?.token);
  const base: string = (found && readJson(join(found, "config.json"))?.api) ?? "https://api.vercel.com"; // the CLI's, if set
  if (!token) return undefined;
  return async (path) => {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} on ${path.split("?")[0]}`);
    return res.json();
  };
}
