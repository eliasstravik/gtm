<!-- BEGIN:gtm -->
## GTM project (managed by @eliasstravik/gtm)

This repo is the company's go-to-market project, `gtm-<company>`: an ordinary Next.js app on `@eliasstravik/gtm`, deployed as one Vercel project of the same name. `npx @eliasstravik/gtm init` rewrites this block; write company notes outside it.

- `context/`: what the company knows, Markdown in any shape; add the company's own kinds of context freely. The Console's Context view shows it; the first heading of `context/company.md` is the company name. Add context only when a person asks for it; for a kind the docs suggest a folder and shape for, read `npx @eliasstravik/gtm docs context` first.
- `workflows/`: Workflow SDK workflows, each registered by name in `workflows/index.ts`, with the description, tables, keys and business diagram the Console shows (docs: workflows). Lasting results go in the workflow's own tables in `db/schema.ts` (schema `public`; schema `gtm` is ours). Ready-made workflows to copy when a person asks for one: `npx @eliasstravik/gtm docs recipes`.
- `.env.example`: every connection name with a one-line comment above it. Values live in `.env.local` (local) or Vercel's env (live), never in git.
- `.agents/skills/`: this company's own project skills.
- `proxy.ts`, `app/layout.tsx`, `app/[[...path]]/page.tsx`, `app/api/gtm/[...path]/route.ts` and `public/_gtm/probe.txt` wire in the Console and its guards.
- Risky or costly runs: run a preview first (`npx @eliasstravik/gtm run <workflow> --input <preview input>`), show its sample and cost in this chat, and start the real run only after a yes here. Runs never wait for people.
- `npm run dev` serves the Console on http://127.0.0.1:$GTM_PORT (default 3000); `npx @eliasstravik/gtm check` lists problems with their fixes and prints the local `DATABASE_URL`.
- Talk to people by the interaction rules (`npx @eliasstravik/gtm docs interaction`): plain business language for a non-technical GTM teammate, replies of at most 280 characters, one question at a time with the native question tool and the recommended choice first, and after a job offer the next ones as a menu instead of doing more unasked. Confirm with Yes/No only destructive actions and risky or costly runs; everything else proceeds directly.
- Before changing layout, workflows, connections or deploy, read node_modules/@eliasstravik/gtm/docs (or `npx @eliasstravik/gtm docs`).
<!-- END:gtm -->
