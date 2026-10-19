# gtm

gtm lets any coding agent (Claude Code, Codex, Cursor or a Slack agent) set up and run a company's
go-to-market work as an ordinary Next.js project on Vercel. The company's know-how (ICPs, personas, voice) is
Markdown in its own repo, its workflows are Workflow SDK code the agent writes, and non-technical GTM people
get one cockpit to read what the agent knows, see what is running, browse the data and add API keys. Locally
it needs no sign-ups: a built-in Postgres, the Workflow SDK's local world, and AI steps on your own
`claude`/`codex`. Live, the same project is one Vercel project behind Vercel's own login, with AI steps on AI
Gateway. Nothing is hosted by us; the keys and services are the company's own.

## Get started

1. **Skill**, for any agent: `npx skills add eliasstravik/gtm -g`, then ask your agent to "set up GTM for Acme".
2. **Claude Code plugin**: `/plugin marketplace add eliasstravik/gtm` then `/plugin install gtm@eliasstravik`
   (or `npx plugins add eliasstravik/gtm`).
3. **Deploy button**: deploys the starter at `v0.0.1` as a new Vercel project with Neon (no Slack agent; add
   it later with `npx @eliasstravik/gtm init --slack`). The cockpit fails closed, showing "Turn on Vercel
   Authentication → All Deployments", until production protection is on; follow [docs/deploy.md](docs/deploy.md).

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Feliasstravik%2Fgtm%2Ftree%2Fv0.0.1%2Fstarter&project-name=gtm&repository-name=gtm&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

## What you get

One repo per company: `context/` (Markdown), `workflows/` (the registry in `workflows/index.ts`), `db/`
(workflow-owned tables), `app/` (the cockpit, webhooks and artifacts: agent-made pages), `AGENTS.md` with a managed
block, `.env.example` listing every connection, and `vercel.json` for schedules. The full layout is in
[docs/layout.md](docs/layout.md); the template itself is [starter/](starter/).

The cockpit has four views: **Context**, **Workflows**, **Data** and **Connections**, plus the artifacts (pages) the agent
adds. Risky or costly runs start only after a yes in chat; the cockpit has no start or approve buttons.

## Docs

The docs match the installed version: `npx @eliasstravik/gtm docs [topic]`, or
`node_modules/@eliasstravik/gtm/docs/` in a project.

| Topic | |
| --- | --- |
| [layout](docs/layout.md) | the project layout and what the cockpit reads |
| [workflows](docs/workflows.md) | the registry, preview → yes in chat → run, `gtm run`, run size |
| [data](docs/data.md) | `db()`, migrations, the production stamp, local data |
| [connections](docs/connections.md) | `.env.example`, saving keys locally and live |
| [artifacts](docs/artifacts.md) | artifacts (agent-made pages) and the exported components |
| [local](docs/local.md) | zero-sign-up local work, AI step backends, switching to real services |
| [deploy](docs/deploy.md) | going live on Vercel |
| [webhooks](docs/webhooks.md) | inbound webhooks |
| [slack](docs/slack.md) | the optional Slack agent |

## License

[MIT](LICENSE)
