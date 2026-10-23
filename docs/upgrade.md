# Upgrade

## From 0.0.4 or earlier

The plugin layout replaces the old wiring, and there is no automatic migration. Make a new project and copy the
company's files across:

1. `npx @eliasstravik/gtm init --company <Company>` in a new folder (it makes `./gtm-<company>`).
2. Copy from the old project: `context/`, `.agents/skills/`, `workflows/`, `db/` (schema and migrations), and the
   names in `.env.example`. Copy `.env.local` too, or set the keys again with `npx gtm connections set`.
3. In `workflows/`, change the imports:
   - `@eliasstravik/gtm/db` → `#gtm/database`
   - `@eliasstravik/gtm/ai` → `#gtm/ai`
   - `import type { Registry } from "@eliasstravik/gtm/api"` → `from "@eliasstravik/gtm"`
4. Mark the workflows that spend money or act on people `approval: { required: true }`, and give scheduled ones
   `budget: { perRunUsd, perMonthUsd }` and a `schedule: { approvedUntil, note }` after a yes (docs: ledger).
5. Inbound webhooks move from `app/api/hooks/<sender>/route.ts` to `webhooks/index.ts` with `webhook()` (docs:
   webhooks).
6. `npx gtm check`, then `npm run dev` and `npx gtm run <workflow> --preview`.
7. Deploy: point the existing Vercel project at the new repo, or create one and move the Neon integration. The new
   `vercel.json` schedules the hourly reconcile, which needs `CRON_SECRET` (docs: deploy). The Slack agent
   and the console's key form are gone: set production keys with `vercel env add` (docs: connections).

The old `gtm.__drizzle_migrations` table stays in the old database; the new one keeps its bookkeeping in each plugin's
schema (`gtm.__gtm_migrations`, `gtm_ledger.__gtm_migrations`, …) and the company's in `drizzle`.

## Between versions

Update the package (`npm install @eliasstravik/gtm@<version>`), then `npx gtm sync` and commit what it changed. A
build fails until then: `gtm check --build` sees the generated files are stale.
