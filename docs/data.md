# Data

## `db()`

`import { db } from "@eliasstravik/gtm/db"` gives Drizzle over a `pg` pool on `DATABASE_URL`, one pool per
process (at most 3 connections locally).

- Locally with no `DATABASE_URL`, `npm run dev` serves the project's own PGlite database on 127.0.0.1 and passes
  its URL to the app. Hosted, `DATABASE_URL` is required and `db()` fails loudly without it.
- It throws during `next build`, so a page that reads data must be dynamic (`export const dynamic = "force-dynamic"`); in workflow files call it only inside `"use step"` bodies.

## Tables and migrations

- Workflow-owned tables live in `public`, defined in `db/schema.ts`. After a schema change run
  `npm run db:generate`, then `npm run db:migrate` (`npx @eliasstravik/gtm migrate`), even while `npm run dev`
  runs; `dev` applies pending migrations only when it starts.
- `gtm migrate` applies the package's own migrations first, then `db/migrations/`, under one advisory lock.
- Schema `gtm` is ours: never create, change or drop anything in it. Company tables never go there.
- `npm run build` runs `gtm migrate` first, so a production deploy migrates production. Preview migrates only
  when Preview has its own `DATABASE_URL` that is not production's; otherwise it skips with a notice.

## Migrations only add

A company migration containing `DROP`, `RENAME`, `TRUNCATE`, `ALTER … TYPE` or `DELETE` is destructive. It
needs a yes in chat, a Neon backup branch of production made before it deploys, and the line
`-- gtm: destructive` in the migration file; a hosted production `gtm migrate` refuses it without that marker.
A Vercel rollback restores code, not the schema.

## The production stamp

A hosted production `gtm migrate` writes `gtm.meta` key `production` = the database identity: for Neon the
endpoint id (host with `-pooler` removed, so pooled and unpooled URLs match), else the host. Neon preview and
dev branches copy the stamp but have other endpoint ids, so they work.

`db()`, `gtm migrate` and `gtm dev` refuse a database whose stamp names its own identity anywhere but hosted
production, even with `VERCEL_ENV=production` in `.env.local`, with "This is production's database; connect a
dev branch instead". It means `DATABASE_URL` here is production's. Remove it from `.env.local` to use the
local database, or connect a Neon dev branch to Development and `vercel env pull` again (local.md).

## Local data

- PGlite data lives in `.gtm/pglite/`; `.gtm/db.lock` names the serving process and port. Other gtm commands
  use the running server; with none running they start a short-lived one.
- Query it with any Postgres client through the URL `npx @eliasstravik/gtm check` prints while `npm run dev`
  runs (`postgres://postgres:postgres@127.0.0.1:<port>/postgres?sslmode=disable`; the port changes per start).
  `sslmode` must be `disable` (or omitted); user and password are ignored; at most 10 connections, of which
  the app's pool uses 3.
- All local connections share ONE Postgres session: a `SET` on one is seen by all, named prepared statements
  collide (Drizzle and `pg` use unnamed ones unless you call `.prepare(name)`), and an open transaction makes
  every other client wait until it ends. Keep transactions short and never leave one idle.
- PGlite is not full Postgres. When something fails only locally, point `DATABASE_URL` at a Neon dev branch.
- A data folder written by another PGlite major version makes `gtm dev` refuse and print the dump and restore
  commands.
- Local data is development data and never moves to production.

## The Data view

Read-only, schema `public` only: estimated row counts (refreshed by `ANALYZE`, which `gtm dev` and
`gtm migrate` run after migrations; "unknown" before the first one), pages of 100 rows, CSV export capped at
10,000 rows / 5 MB with a "truncated" notice. It runs no SQL from the browser.
