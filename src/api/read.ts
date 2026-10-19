/** Read-only cockpit endpoints: Shell, Context and Data (plan §4). The project root is process.cwd(). */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { assertNotProduction, databaseIdentity, environment, isHosted, PRODUCTION_DATABASE, value } from "../shared/env.js";
import { artifactSlugs } from "../shared/scan.js";
import { HttpError, json, toJson } from "./http.js";

const PAGE_SIZE = 100;
const CSV_ROWS = 10_000;
const CSV_BYTES = 5 * 1024 * 1024;

const read = (file: string) => readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), file), "utf8").catch(() => null);

/** The first heading (only `# ` when h1), ignoring front matter and a closing `#` sequence. */
function heading(markdown: string, h1 = false): string | undefined {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return body.match(h1 ? /^# +(.+?)(?:\s+#+)?\s*$/m : /^#{1,6} +(.+?)(?:\s+#+)?\s*$/m)?.[1];
}

/** GET /shell → { company, environment, database, artifacts }. Dev rescans app/ per request; hosted reads GTM_ARTIFACTS. */
export async function shell(): Promise<Response> {
  const company = heading((await read("context/company.md")) ?? "", true) ?? "GTM";
  const url = value("DATABASE_URL");
  // An unparseable URL shows as no database; Data reports the real error.
  const database = url && URL.canParse(url) ? databaseIdentity(url) : null;
  // process.env.GTM_ARTIFACTS literally, so the value withGtm inlines at build time is the one read.
  const artifacts: string[] = isHosted() ? JSON.parse(process.env.GTM_ARTIFACTS ?? "[]") : artifactSlugs();
  return json({ company, environment: environment(), database, artifacts });
}

/** Repo-relative paths the Context view may show: context/**\/*.md; under "Skills", AGENTS.md and .agents/skills/*\/SKILL.md. */
async function contextPaths(): Promise<{ context: string[]; skills: string[] }> {
  const files = await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), "context"), { recursive: true }).catch(() => [] as string[]);
  const context = files.filter((f) => f.endsWith(".md")).map((f) => `context/${f.split(path.sep).join("/")}`).sort();
  const skills = (await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), ".agents/skills")).catch(() => [] as string[])).sort();
  return { context, skills: ["AGENTS.md", ...skills.map((s) => `.agents/skills/${s}/SKILL.md`)] };
}

/** GET /context → { groups: [{ name: "Context" | "Skills", files: [{ path, title }] }] } (missing files left out). */
export async function contextList(): Promise<Response> {
  const { context, skills } = await contextPaths();
  const entry = async (p: string) => {
    const markdown = await read(p);
    const name = p.endsWith("/SKILL.md") ? p.split("/").at(-2)! : path.basename(p, ".md");
    return markdown == null ? [] : [{ path: p, title: heading(markdown) ?? name }];
  };
  const files = async (paths: string[]) => (await Promise.all(paths.map(entry))).flat();
  return json({ groups: [{ name: "Context", files: await files(context) }, { name: "Skills", files: await files(skills) }] });
}

/** GET /context/file?path= → { path, markdown, githubUrl }; only paths the listing returns (no traversal). */
export async function contextFile(file: string | null): Promise<Response> {
  const { context, skills } = await contextPaths();
  const markdown = file && [...context, ...skills].includes(file) ? await read(file) : null;
  if (file == null || markdown == null) throw new HttpError(404, "No such context file");
  const { VERCEL_GIT_PROVIDER: git, VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug, VERCEL_GIT_COMMIT_REF: ref } = process.env;
  const segments = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const githubUrl =
    isHosted() && git === "github" && owner && slug && ref ? `https://github.com/${owner}/${slug}/blob/${segments(ref)}/${segments(file)}` : null;
  return json({ path: file, markdown, githubUrl });
}

type Query = (text: string, values?: unknown[]) => Promise<pg.QueryArrayResult>;
type Db = { url: string; pool: pg.Pool; checked: boolean };
const POOL = Symbol.for("@eliasstravik/gtm/api/pool");

/** Runs fn inside BEGIN READ ONLY … ROLLBACK on this process's small pool, after the production-stamp check. */
async function readOnly<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const url = value("DATABASE_URL");
  if (!url) throw new HttpError(503, "DATABASE_URL is not set. Locally, start the app with `gtm dev`; hosted, connect a database.");
  const g = globalThis as unknown as Record<symbol, Db | undefined>;
  if (g[POOL]?.url !== url) {
    g[POOL]?.pool.end().catch(() => {});
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    pool.on("error", () => {}); // an idle client dropped by the server must not crash the process
    g[POOL] = { url, pool, checked: false };
  }
  const db = g[POOL]!;
  if (!db.checked) {
    await assertNotProduction(async (sql) => (await db.pool.query(sql)).rows, url).catch((e: Error) => {
      throw e.message === PRODUCTION_DATABASE ? new HttpError(403, e.message) : e;
    });
    db.checked = true;
  }
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    return await fn((text, values) => client.query({ text, values, rowMode: "array" }));
  } finally {
    client.release(await client.query("ROLLBACK").then(() => false, () => true)); // a client that cannot roll back is dropped
  }
}

const PUBLIC_TABLES = "information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'";

/** GET /data → { tables: [{ name, estimatedRows }] }; estimatedRows is null while Postgres has no estimate (-1). */
export async function dataTables(): Promise<Response> {
  const { rows } = await readOnly((q) =>
    q(`select t.table_name, (select c.reltuples::float8 from pg_class c
         where c.relname = t.table_name and c.relnamespace = 'public'::regnamespace) from ${PUBLIC_TABLES} order by 1`));
  return json({ tables: rows.map(([name, n]) => ({ name, estimatedRows: n == null || n < 0 ? null : Math.round(n) })) });
}

/** The quoted identifier of a listed public table; any other name is a 404. */
async function table(q: Query, name: string): Promise<string> {
  const { rows } = await q(`select 1 from ${PUBLIC_TABLES} and t.table_name = $1`, [name]);
  if (!rows.length) throw new HttpError(404, `No table "${name}" in schema public`);
  return `"public"."${name.replaceAll('"', '""')}"`;
}

/** GET /data/<table>?page=<n> (1-based) → { table, columns, rows, page, pageSize: 100, hasMore }. */
export async function dataPage(name: string, pageParam: string | null): Promise<Response> {
  const page = pageParam ? Number(pageParam) : 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "page must be a whole number from 1");
  return json(await readOnly(async (q) => {
    const r = await q(`select * from ${await table(q, name)} order by ctid limit ${PAGE_SIZE + 1} offset ${(page - 1) * PAGE_SIZE}`);
    const columns = r.fields.map((f) => f.name);
    return { table: name, columns, rows: r.rows.slice(0, PAGE_SIZE), page, pageSize: PAGE_SIZE, hasMore: r.rows.length > PAGE_SIZE };
  }));
}

function csvCell(v: unknown): string {
  const s =
    v == null ? ""
    : v instanceof Date ? (Number.isNaN(v.getTime()) ? String(v) : v.toISOString())
    : v instanceof Uint8Array ? `\\x${Buffer.from(v).toString("hex")}`
    : typeof v === "object" ? toJson(v)
    : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** GET /data/<table>/csv → CSV of up to 10,000 rows / 5 MB; when capped, `x-gtm-truncated: 1` and a final `# truncated`. */
export async function dataCsv(name: string): Promise<Response> {
  const { body, truncated } = await readOnly(async (q) => {
    const t = await table(q, name);
    const lines: string[] = [];
    let bytes = 0;
    // Chunks of 1,000 keep memory near the cap; past 10,000 rows or 5 MB (less room for the notice) it stops.
    for (let offset = 0; ; offset += 1000) {
      const r = await q(`select * from ${t} order by ctid limit 1000 offset ${offset}`);
      if (offset === 0) lines.push(r.fields.map((f) => csvCell(f.name)).join(","));
      for (const line of r.rows.map((row) => row.map(csvCell).join(","))) {
        bytes += Buffer.byteLength(line) + 1;
        if (lines.length > CSV_ROWS || bytes > CSV_BYTES - 64) return { body: `${lines.join("\n")}\n# truncated\n`, truncated: true };
        lines.push(line);
      }
      if (r.rows.length < 1000) return { body: `${lines.join("\n")}\n`, truncated: false };
    }
  });
  const headers = { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}.csv"`, ...(truncated && { "x-gtm-truncated": "1" }) };
  return new Response(body, { headers });
}
