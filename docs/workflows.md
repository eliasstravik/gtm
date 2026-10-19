# Workflows

## The registry

`workflows/index.ts` exports `workflows = { <name>: workflowFn }`. The key is the workflow's name everywhere:
`npx @eliasstravik/gtm run <name>`, `/api/gtm/start/<name>`, `/api/gtm/cron/<name>` and the Workflows view.
gtm starts only registered workflows; `npx @eliasstravik/gtm check` reports a broken registry.

## Results and runs

- A workflow writes its lasting results to its own tables in `public` through `db()` (data.md).
- Runs live only in the Workflow SDK's run store (`.workflow-data/` locally; 7 days on Vercel Pro). There is
  no run-history table; the Workflows view shows what the store keeps.
- Schedules: `vercel.json` crons whose path is `/api/gtm/cron/<name>`. Vercel Cron runs them in production
  only, with `CRON_SECRET`; the route refuses when it is unset. A cron run gets no input.
  Locally nothing fires on its own; start it with
  `npx @eliasstravik/gtm run <name>`.

## Preview, yes in chat, run

Runs never pause for people, and the Console has no start or approve buttons. For a risky or costly run:

1. Run a preview: the same workflow with preview input (for example a row limit), whose return value carries
   the sample rows and the measured cost. Read it through `npx @eliasstravik/gtm run` (below).
2. Show the sample and the cost quote in the chat you are in (Claude Code, Codex or the Slack thread) and ask.
3. Start the real run only after a yes in that chat.

Cost quotes: a local preview on `claude`/`codex` measures plan usage, not money. Quote a hosted or scheduled
run as the hosted model's AI Gateway price × the preview's token `usage`, or run a one-row hosted preview with
`--prod`. A schedule's yes quotes cost per run × runs per month.

## `gtm run`

```sh
npx @eliasstravik/gtm run <workflow> [--input '<json>'] [--prod] [--no-wait]
```

- Default: `POST http://127.0.0.1:$GTM_PORT/api/gtm/start/<workflow>`, so `npm run dev` must be running.
- `--prod`: the same on `GTM_PRODUCTION_URL` with the `x-vercel-protection-bypass` header set to
  `GTM_BYPASS_SECRET`, both from `.env.local` (deploy.md).
- It waits and prints the run's status, return value and error; `--no-wait` prints only the run id.
- `--input` is one JSON value; single-quote it in the shell.
- Start and runs answer only on `127.0.0.1`/`localhost` locally (never on a `GTM_ALLOWED_HOSTS` host) and
  only with the bypass header when hosted, never to a browser.

## Run size

Keep each run under ~2,000 events (the Workflow SDK caps a run at 25,000 and replay slows past ~2,000): about
20 rows per run when each row calls `agent()` with tools through AI Gateway (a measured one-row tool stage
made ~120 events; a measured tool-less `agent()` row makes ~6), about 100 rows when rows are plain steps. Fan
larger lists out into child runs of that size.

## Scope rules

- `db()` (`@eliasstravik/gtm/db`) only inside `"use step"` bodies. A workflow-scope reference to anything from
  a module that reaches `db()` pulls `pg` into the workflow bundle and the build fails.
- `agent()` (`@eliasstravik/gtm/ai`) only in workflow scope, never inside a `"use step"` body; it makes its own
  steps. Options: `name`, `instructions`, `prompt`, `schema`, `model?`, `reasoning?`, `tools?` (`mcp`, `web`,
  `custom`), `maxSteps?`, `timeout?`. It returns `{ value, costUsd, modelCalls, toolCalls, usage }`;
  on the `claude`/`codex` CLI path `toolCalls` is always `[]` (the CLI runs its own tool loop). Backends and models: local.md.
