# gtm

gtm lets any coding agent (Claude Code, Codex, Cursor or a Slack agent) set up and run a company's
go-to-market work as an ordinary Next.js project on Vercel. The company's know-how (ICPs, personas, voice) is
Markdown in its own repo, its workflows are Workflow SDK code the agent writes, and non-technical GTM people
get one Console to read what the agent knows, see what is running, browse the data and add API keys. Locally
it needs no sign-ups: a built-in Postgres, the Workflow SDK's local world, and AI steps on your own
`claude`/`codex`. Live, the same project is one Vercel project behind Vercel's own login, with AI steps on AI
Gateway. Nothing is hosted by us; the keys and services are the company's own.

## Get started

1. **Skill**, for any agent: `npx skills add eliasstravik/gtm -g`, then ask your agent to "set up GTM for Acme"
   (it runs `npx @eliasstravik/gtm init --company Acme`, which creates `./gtm-acme` with the base files only, then
   asks what to add). For a demo, `init --company Acme --example` adds one small marked example workflow.
2. **Claude Code plugin**: `/plugin marketplace add eliasstravik/gtm` then `/plugin install gtm@eliasstravik`
   (or `npx plugins add eliasstravik/gtm`).
3. **Deploy button**: deploys the starter at `v0.0.3` as a new Vercel project with Neon, suggested as
   `gtm-company`: put the company's name in place of `company` (`gtm-acme`) for both the repo and the project (no
   Slack agent; add it later with `npx @eliasstravik/gtm init --slack`). The Console fails closed, showing "Turn on Vercel
   Authentication → All Deployments", until production protection is on; follow [docs/deploy.md](docs/deploy.md).

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Feliasstravik%2Fgtm%2Ftree%2Fv0.0.3%2Fstarter&project-name=gtm-company&repository-name=gtm-company&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

## What you get

One repo per company, named `gtm-<company>` (`gtm-acme`): `context/` (Markdown), `.agents/skills/` (the company's
skills, one `<name>/SKILL.md` each, for Claude Code, Codex, the Slack agent and workflow `agent()` steps),
`workflows/` (the registry in `workflows/index.ts`), `db/` (workflow-owned tables), `app/` (the Console and webhooks), `AGENTS.md` with a managed
block, `.env.example` listing every connection, and `vercel.json` for schedules. The full layout is in
[docs/layout.md](docs/layout.md); the template itself is [starter/](starter/).

The Console is the web UI the GTM team uses: a sidebar with the company and its environment, then **Context**
(what the agent knows), **Workflows** with their **Runs**, **Data** (every workflow table, searchable, with CSV and
JSON export) and **Connections** (which API keys are set; add or replace one). Risky or costly runs start only after
a yes in chat; the Console has no start or approve buttons.

## Docs

The docs match the installed version: `npx @eliasstravik/gtm docs [topic]`, or
`node_modules/@eliasstravik/gtm/docs/` in a project.

| Topic | |
| --- | --- |
| [layout](docs/layout.md) | the project layout and what the Console reads |
| [recipes](docs/recipes.md) | ready-made workflows to copy: import a list, enrich companies, a weekly scheduled job |
| [context](docs/context.md) | the basics at setup, and a suggested layout for company facts, members, ICPs, personas |
| [interaction](docs/interaction.md) | how agents talk to the GTM team: plain replies, one question at a time, what needs a yes |
| [workflows](docs/workflows.md) | the registry, preview → yes in chat → run, `gtm run`, run size |
| [data](docs/data.md) | `db()`, migrations, the production stamp, local data |
| [connections](docs/connections.md) | `.env.example`, saving keys locally and live |
| [local](docs/local.md) | zero-sign-up local work, AI step backends, switching to real services |
| [deploy](docs/deploy.md) | going live on Vercel |
| [webhooks](docs/webhooks.md) | inbound webhooks |
| [slack](docs/slack.md) | the optional Slack agent |

## Future direction

Not built yet, but the layout leaves room for them: built-in CRM and sequencer parts, and **Artifacts**, pages the
agent makes for the company (reports, dashboards) listed in the Console's sidebar.

## Releasing

One version for the package, the starter's pin, the plugin manifests and the Deploy button's tag. Releases publish
from GitHub Actions ([release.yml](.github/workflows/release.yml)) through npm trusted publishing, so no npm token
lives on any machine and every version carries provenance:

1. Set `version` in `package.json` (and `package-lock.json`) to the release candidate, for example `0.0.4-rc.1`, merge
   to `main`, then push the tag: `git tag v0.0.4-rc.1 && git push origin v0.0.4-rc.1`. A pre-release tag publishes
   under `next`; mark its GitHub release as a pre-release.
2. Check the candidate in a project made with `npx @eliasstravik/gtm@next init`, which pins the candidate
   (`^0.0.4-rc.1`), and in a Vercel deploy of such a project. Not the starter or the Deploy button: their `^0.0.3`
   pin never matches a pre-release, so they would still install the previous version.
3. Set `version` to `0.0.4` in `package.json`, `package-lock.json`, `plugin.json` and `.claude-plugin/plugin.json`,
   the MCP client version in `src/ai/tools.ts`, the starter's pin to `^0.0.4` and the Deploy button's tag to `v0.0.4`;
   merge, push tag `v0.0.4` (publishes under `latest`) and make its GitHub release.

The tag must match `package.json`, or the workflow refuses. The trust between npm and this repo's `release.yml` was
set once with `npm trust github @eliasstravik/gtm --repo eliasstravik/gtm --file release.yml --allow-publish`;
renaming the workflow file breaks it.

## License

[MIT](LICENSE)
