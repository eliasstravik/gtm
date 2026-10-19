/** Read-only cockpit endpoints: Shell, Context and Data (plan §4). The project root is process.cwd(). */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { assertNotProduction, databaseIdentity, environment, isHosted, PRODUCTION_DATABASE, value } from "../shared/env.js";
import { parseSkill, SKILL_NAME, SKILLS_DIR } from "../shared/skill.js";
import { missingConnections } from "./connections.js";
import type { Registry } from "./runs.js";
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

/**
 * GET /shell → { company, environment, database, deployment, connectionsMissing }: `deployment` changes with every
 * deploy (so open pages reload for new code), `connectionsMissing` counts keys not set here.
 */
export async function shell(workflows: Registry): Promise<Response> {
  const company = heading((await read("context/company.md")) ?? "", true) ?? "GTM";
  const url = value("DATABASE_URL");
  // An unparseable URL shows as no database; Data reports the real error.
  const database = url && URL.canParse(url) ? databaseIdentity(url) : null;
  const connectionsMissing = missingConnections(workflows);
  return json({ company, environment: environment(), database, deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null, connectionsMissing });
}

/**
 * What the Context view may show: every context/**\/*.md, and under "Skills" each folder in .agents/skills that holds
 * a SKILL.md, titled by its front matter `name` (else the folder) with its `description`. AGENTS.md is not context.
 */
async function contextPaths() {
  const files = await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), "context"), { recursive: true }).catch(() => [] as string[]);
  const context = files.filter((f) => f.endsWith(".md")).map((f) => `context/${f.split(path.sep).join("/")}`).sort();
  const folders = (await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), SKILLS_DIR)).catch(() => [] as string[])).filter((f) => SKILL_NAME.test(f)).sort();
  const skills = (await Promise.all(folders.map(async (folder) => {
    const p = `${SKILLS_DIR}/${folder}/SKILL.md`, markdown = await read(p);
    const { name, description } = parseSkill(markdown ?? "");
    return markdown == null ? [] : [{ path: p, title: name ?? folder, ...(description && { description }) }];
  }))).flat();
  return { context, skills };
}

/** GET /context → { groups: [{ name: "Context" | "Skills", files: [{ path, title, description? }] }] } (missing files left out). */
export async function contextList(): Promise<Response> {
  const { context, skills } = await contextPaths();
  const entry = async (p: string) => {
    const markdown = await read(p);
    return markdown == null ? [] : [{ path: p, title: heading(markdown) ?? path.basename(p, ".md") }];
  };
  return json({ groups: [{ name: "Context", files: (await Promise.all(context.map(entry))).flat() }, { name: "Skills", files: skills }] });
}

/** GET /context/file?path= → { path, markdown, githubUrl }; only paths the listing returns (no traversal). */
export async function contextFile(file: string | null): Promise<Response> {
  const { context, skills } = await contextPaths();
  const markdown = file && [...context, ...skills.map((s) => s.path)].includes(file) ? await read(file) : null;
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

const NUMERIC = new Set([20, 21, 23, 700, 701, 1700]), JSONB = new Set([114, 3802]);
const typeOf = (oid: number) => (NUMERIC.has(oid) ? "number" : oid === 16 ? "boolean" : JSONB.has(oid) ? "json" : "text");
const ident = (c: string) => `"${c.replaceAll('"', '""')}"`;
const OPERATORS: Record<string, string> = { eq: "=", ne: "is distinct from", gt: ">", lt: "<" };

/**
 * The table's columns, and the `where` / `order by` the query string asks for: `q` matches any value as text, `field`
 * with `operator` (eq, ne, gt, lt, missing) and `value` filters one column (numbers compare as numbers), `sort` and
 * `order` sort, and `columns` (comma-separated) picks the columns returned.
 */
async function view(q: Query, name: string, p: URLSearchParams) {
  const t = await table(q, name);
  const head = await q(`select * from ${t} limit 0`);
  const fields = head.fields.map((f) => ({ name: f.name, type: typeOf(f.dataTypeID) }));
  const known = (c: string | null) => (c && fields.some((f) => f.name === c) ? c : null);
  const values: unknown[] = [], where: string[] = [];
  const search = p.get("q")?.trim();
  if (search) where.push(`x::text ilike $${values.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`)}`);
  const field = known(p.get("field")), op = p.get("operator") ?? "eq";
  if (field && op === "missing") where.push(`x.${ident(field)} is null`);
  else if (field && OPERATORS[op] && p.has("value")) {
    const number = fields.find((f) => f.name === field)!.type === "number" && (op === "gt" || op === "lt");
    if (number && !(p.get("value")!.trim() && Number.isFinite(Number(p.get("value"))))) throw new HttpError(400, `${field} holds numbers: compare it with a number.`);
    where.push(`x.${ident(field)}${number ? "" : "::text"} ${OPERATORS[op]} $${values.push(p.get("value"))}${number ? "::numeric" : ""}`);
  }
  const sort = known(p.get("sort")), order = p.get("order") === "desc" ? "desc" : "asc";
  const picked = (p.get("columns") ?? "").split(",").filter(known);
  const columns = picked.length ? picked : fields.map((f) => f.name);
  // The name column stays on screen while the grid scrolls sideways.
  const pinned = columns.find((c) => /(^|_)(name|title)$/i.test(c)) ?? null;
  return {
    t, fields, columns, pinned, values, select: columns.map((c) => `x.${ident(c)}`).join(", "),
    where: where.length ? `where ${where.join(" and ")}` : "", order: `order by ${sort ? `x.${ident(sort)} ${order} nulls last, ` : ""}x.ctid`,
  };
}

/**
 * GET /data/<table>?offset=&limit= (plus view()'s filters) → { table, fields, columns, pinned, rows, offset, total }:
 * up to 200 rows from `offset`, and how many rows match.
 */
export async function dataPage(name: string, p: URLSearchParams): Promise<Response> {
  const offset = Number(p.get("offset") ?? 0), limit = Number(p.get("limit") ?? PAGE_SIZE);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(400, "offset must be a whole number from 0 and limit from 1 to 200");
  }
  return json(await readOnly(async (q) => {
    const v = await view(q, name, p);
    const [rows, count] = [await q(`select ${v.select} from ${v.t} x ${v.where} ${v.order} limit ${limit} offset ${offset}`, v.values),
      await q(`select count(*)::float8 from ${v.t} x ${v.where}`, v.values)];
    return { table: name, fields: v.fields, columns: v.columns, pinned: v.pinned, rows: rows.rows, offset, total: count.rows[0][0] };
  }));
}

/** A CSV cell. Text a spreadsheet would run as a formula (= + - @ first, or a tab or CR) gets a leading '; numbers stay. */
function csvCell(v: unknown): string {
  let s =
    v == null ? ""
    : v instanceof Date ? (Number.isNaN(v.getTime()) ? String(v) : v.toISOString())
    : v instanceof Uint8Array ? `\\x${Buffer.from(v).toString("hex")}`
    : typeof v === "object" ? toJson(v)
    : String(v);
  if (/^\s*[=+\-@]|^[\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * GET /data/<table>/csv or /json (with view()'s filters, sort and columns) → up to 10,000 rows / 5 MB as a download; when
 * capped, `x-gtm-truncated: 1` and, in CSV, a final `# truncated`.
 */
export async function dataExport(name: string, format: string, p: URLSearchParams): Promise<Response> {
  if (format !== "csv" && format !== "json") throw new HttpError(404, `No export format "${format}"`);
  const line = format === "csv" ? (row: unknown[]) => row.map(csvCell).join(",") : (row: unknown[], cols: string[]) =>
    toJson(Object.fromEntries(cols.map((c, i) => [c, row[i]])));
  const { lines, truncated } = await readOnly(async (q) => {
    const v = await view(q, name, p);
    const lines: string[] = format === "csv" ? [v.columns.map(csvCell).join(",")] : [];
    let bytes = 0;
    // Chunks of 1,000 keep memory near the cap; past 10,000 rows or 5 MB (less room for the notice) it stops.
    for (let offset = 0; ; offset += 1000) {
      const r = await q(`select ${v.select} from ${v.t} x ${v.where} ${v.order} limit 1000 offset ${offset}`, v.values);
      for (const text of r.rows.map((row) => line(row, v.columns))) {
        bytes += Buffer.byteLength(text) + 2;
        if (lines.length > CSV_ROWS || bytes > CSV_BYTES - 64) return { lines, truncated: true };
        lines.push(text);
      }
      if (r.rows.length < 1000) return { lines, truncated: false };
    }
  });
  const body = format === "csv" ? `${lines.join("\n")}\n${truncated ? "# truncated\n" : ""}` : `[${lines.join(",\n")}]\n`;
  const headers = { "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}.${format}"`, ...(truncated && { "x-gtm-truncated": "1" }) };
  return new Response(body, { headers });
}
