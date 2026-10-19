<!-- BEGIN:gtm -->
## GTM project (managed by @eliasstravik/gtm)

This repo is the company's go-to-market project: an ordinary Next.js app on `@eliasstravik/gtm`, deployed as one Vercel project. `npx @eliasstravik/gtm init` rewrites this block; write company notes outside it.

- `context/`: what the company knows (company.md, ICPs, personas, voice), Markdown in any shape. The cockpit's Context view shows it; the first heading of `context/company.md` is the company name.
- `workflows/`: Workflow SDK workflows, each registered by name in `workflows/index.ts`. Lasting results go in the workflow's own tables in `db/schema.ts` (schema `public`; schema `gtm` is ours).
- `.env.example`: every connection name with a one-line comment above it. Values live in `.env.local` (local) or Vercel's env (live), never in git.
- `app/<slug>/page.tsx`: extra cockpit pages, listed under "Pages". `.agents/skills/`: this company's own project skills.
- `proxy.ts`, `app/layout.tsx`, `app/[[...path]]/page.tsx`, `app/api/gtm/[...path]/route.ts` and `public/_gtm/probe.txt` wire in the cockpit and its guards.
- Risky or costly runs: run a preview first (`npx @eliasstravik/gtm run <workflow> --input <preview input>`), show its sample and cost in this chat, and start the real run only after a yes here. Runs never wait for people.
- `npm run dev` serves the cockpit on http://127.0.0.1:$GTM_PORT (default 3000); `npx @eliasstravik/gtm check` lists problems with their fixes and prints the local `DATABASE_URL`.
- Before changing layout, workflows, connections or deploy, read node_modules/@eliasstravik/gtm/docs (or `npx @eliasstravik/gtm docs`).
<!-- END:gtm -->
