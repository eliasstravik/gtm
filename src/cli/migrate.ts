import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { PRODUCTION_DATABASE, assertNotProduction, databaseIdentity, environment, isHosted, value } from "../shared/env.js";
import { withDatabase, withMigrateLock } from "./localdb.js";
import { findProject, loadEnv, packageRoot } from "./project.js";

const MARKER = /--\s*gtm:\s*destructive/i;
// Matched after removing comments and `ON DELETE` (a foreign-key clause, not a delete).
const DESTRUCTIVE = /\b(DROP|RENAME|TRUNCATE|DELETE)\b|\bALTER\s+(TYPE|COLUMN\s+("[^"]*"|\w+)\s+(SET\s+DATA\s+)?TYPE)\b/i;

/** `gtm migrate`: hosted production (stamps), hosted preview (only on its own database), or the local database. */
export async function migrateCommand(_args: string[]): Promise<void> {
  const dir = findProject();
  loadEnv(dir, !isHosted());
  const where = environment();
  if (where === "local") return withDatabase(dir, (url) => migrate(dir, url));
  const url = value("DATABASE_URL");
  if (where === "production") {
    if (!url) throw new Error("DATABASE_URL is not set for Production: connect Neon via the Vercel Marketplace; see `npx @eliasstravik/gtm docs deploy`.");
    return migrate(dir, url);
  }
  if (!url) return console.log("gtm migrate: Preview has no DATABASE_URL of its own; skipping migrations.");
  await migrate(dir, url).catch((error: Error) => {
    if (error.message !== PRODUCTION_DATABASE) throw error;
    console.log("gtm migrate: Preview's DATABASE_URL is production's database; skipping migrations (give Preview its own Neon branch).");
  });
}

/**
 * Applies our migrations (schema `gtm`), then the company's `db/migrations`, after the production-stamp check. In
 * hosted production it first refuses destructive pending company migrations, and afterwards stamps the database.
 */
export async function migrate(dir: string, url: string): Promise<void> {
  const production = environment() === "production";
  const run = async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await assertNotProduction(async (sql) => (await client.query(sql)).rows, url);
      const db = drizzle({ client });
      let applied = await applySet(client, db, join(packageRoot(), "migrations"), "gtm", false);
      const theirs = join(dir, "db", "migrations");
      if (existsSync(join(theirs, "meta", "_journal.json"))) applied += await applySet(client, db, theirs, "drizzle", production);
      if (production) {
        await client.query("insert into gtm.meta (key, value) values ('production', $1) on conflict (key) do update set value = excluded.value", [databaseIdentity(url)]);
      }
      if (String((await client.query("select version()")).rows[0].version).includes("PGlite")) await client.query(ANALYZE_FILLED);
      console.log(applied ? `gtm migrate: applied ${applied} migration(s).` : "gtm migrate: the database is up to date.");
    } finally {
      await client.end();
    }
  };
  return isHosted() ? run() : withMigrateLock(dir, run);
}

// PGlite has no autovacuum, so the Data view's estimates stay "unknown" until ANALYZE. Empty tables are skipped:
// their 0 would go stale as rows arrive, while "unknown" stays honest.
const ANALYZE_FILLED = `do $$ declare t regclass; filled boolean; begin
  for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('select exists (select 1 from %s)', t) into filled;
    if filled then execute format('analyze %s', t); end if;
  end loop; end $$`;

/**
 * One migration folder inside one transaction holding the migrate lock, which makes Drizzle's read of the last
 * applied entry and its applies atomic. A transaction-scoped advisory lock also holds through Neon's pooler, where a
 * session lock can stay stuck on a pooled backend. Drizzle's own BEGIN inside ours is a no-op warning; its COMMIT
 * ends ours.
 */
async function applySet(client: pg.Client, db: NodePgDatabase, folder: string, schema: string, guard: boolean): Promise<number> {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('gtm-migrate'))");
    const pending = await pendingMigrations(client, folder, schema);
    if (guard) refuseDestructive(folder, pending);
    await drizzleMigrate(db, { migrationsFolder: folder, migrationsSchema: schema, migrationsTable: "__drizzle_migrations" });
    return pending.length;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** Journal entries Drizzle will apply: all when nothing is recorded, else those newer than the last created_at. */
async function pendingMigrations(client: pg.Client, folder: string, schema: string): Promise<string[]> {
  const journal: { entries: { tag: string; when: number }[] } = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
  const table = `${schema}.__drizzle_migrations`;
  const exists = (await client.query("select to_regclass($1) as t", [table])).rows[0].t;
  const last = exists ? (await client.query(`select created_at from ${table} order by created_at desc limit 1`)).rows[0] : undefined;
  return journal.entries.filter((e) => !last || Number(last.created_at) < e.when).map((e) => e.tag);
}

function refuseDestructive(folder: string, tags: string[]): void {
  const risky = tags.filter((tag) => {
    const sql = readFileSync(join(folder, `${tag}.sql`), "utf8");
    return !MARKER.test(sql) && DESTRUCTIVE.test(sql.replace(/--.*$/gm, "").replace(/\bON\s+DELETE\b/gi, ""));
  });
  if (risky.length) {
    throw new Error(
      `gtm migrate refused on production: ${risky.map((t) => `db/migrations/${t}.sql`).join(", ")} may lose data ` +
        "(DROP, RENAME, TRUNCATE, ALTER … TYPE or DELETE). After a yes in chat and a Neon backup branch, add the line " +
        "`-- gtm: destructive` to the file (see `npx @eliasstravik/gtm docs data`).",
    );
  }
}
