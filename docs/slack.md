# Slack agent

The optional Slack agent is an ordinary eve agent in `agent/`, deployed in the same Vercel project.

## What `init --slack` adds

`npx @eliasstravik/gtm init --slack` adds only files and the `eve` dependency: `agent/agent.ts`,
`agent/instructions.md`, `agent/channels/slack.ts`, `agent/channels/eve.ts` (deny-all), `agent/lib/` (the member
allowlist, the requester-only approval policy, calls to the app's API), `agent/tools/` (`start_run`, `get_run`,
`github`), `agent/sandbox.ts` and `agent/skills` (a symlink to
`../.agents/skills`, which eve follows, so the agent has the company's skills). eve loads every entry there
as a skill, so `--slack` deletes `.agents/skills/.gitkeep`, and nothing but skills may go in that folder; a
missing (not yet created) folder is fine. `withGtm` applies `withEve`
because `agent/` exists. With `agent/` present, `npm run dev` keeps eve's dev server on 127.0.0.1 too, or
refuses to start.

- `agent/instructions.md`: read `AGENTS.md` and `context/` from the repo checkout the GitHub tools provide;
  follow the preview → yes → run rule (workflows.md); never act on a yes that did not arrive through an
  approval request.
- `agent/channels/eve.ts` is `eveChannel({ auth: [] })`: deny-all, so `/eve/v1/session` refuses everyone,
  Vercel OIDC callers included. Keep it that way. `GET /eve/v1/health` stays public.
- No eve schedules; crons live in `vercel.json`.

## Slack credentials

Portable credentials, not Vercel Connect (Connect's Slack triggers need a Deployment Protection Exception,
which is never allowed):

- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` as Production Secrets, set with `vercel env add` (Connections'
  Save refuses `SLACK_*`).
- Slack's Event Subscriptions and Interactivity Request URLs carry Slack's own labeled bypass secret:
  `https://<production domain>/eve/v1/slack?x-vercel-protection-bypass=<Slack's secret>`. Never the one
  deployments see as `VERCEL_AUTOMATION_BYPASS_SECRET`. On Vercel, `/eve/v1/*` goes to eve's own service before
  Next.js, so `proxy.ts` never sees it: Slack's signature check and eve's channel auth are its only guards
  (locally the proxy's loopback rule applies too).

## Who can command it

Only full members of the company's Slack. Every eve entry hook (`onAppMention`, `onDirectMessage`,
`onMessage`, `onSlashCommand`, `onShortcut`, `onInteraction`, `onEvent`) runs the same allowlist:

- Refuse users whose `users.info` shows `is_restricted`, `is_ultra_restricted`, `is_bot` or `deleted`, or a
  team outside the company.
- Refuse conversations whose `conversations.info` shows `is_ext_shared` or `is_pending_ext_shared`.
- "The company" is the bot's own `auth.test` `team_id` (or `enterprise_id` on Enterprise Grid, so any
  workspace of the same grid counts), never the event envelope.

## The yes

- The start-run and commit/push tools carry eve's `approval` policy, and `onInputResponse` accepts only the
  person who asked. The yes is enforced by code, not by the model reading thread text.
- Repo edits go through eve's git extension with GitHub via Vercel Connect (a person creates and installs
  the Connect GitHub app); after the yes the agent commits and pushes to `main`, and Vercel redeploys.
- The start-run tool calls `POST /api/gtm/start/<workflow>` with the automation bypass header, so the run
  lives in the app and shows in the cockpit (an in-process start would run in eve's own service and not
  show). The tool reads `VERCEL_AUTOMATION_BYPASS_SECRET` and `VERCEL_PROJECT_PRODUCTION_URL` from the deployment.
- `GTM_VERCEL_TOKEN` is never passed into the eve sandbox.
