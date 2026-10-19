# Local

## Zero sign-ups

`npm run dev` (`npx @eliasstravik/gtm dev`) needs no account: it serves the project's own PGlite database on
127.0.0.1 (data.md), applies pending migrations, and runs `next dev` with the Workflow SDK's local world. The
Console is `http://127.0.0.1:$GTM_PORT/` (default 3000), with no login. Anything under `gtm dev` or `next dev` is
never "hosted", whatever the env files say; the CLI loads env files exactly as Next does. Local data is
development data and never moves to production.

## `agent()` backends

Every AI call in a workflow, one-shot or tool-using, is `agent()` (workflows.md, AI steps), so these are its only
paths: workflow code never calls the AI SDK or a provider itself and never names a model id. Hosted, `agent()` always uses AI Gateway (the deployment's OIDC token, or `AI_GATEWAY_API_KEY`), with every
model and tool call a step. On a laptop the first match wins, per call:

1. AI Gateway, when `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is set. A pulled OIDC token expires; the error
   then says to run `vercel env pull` again.
2. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, through their AI SDK providers.
3. The headless `claude -p` or `codex exec` the person is already signed into: `GTM_AGENT_BACKEND` (`claude` or
   `codex`; `init` writes it to `.env.local` for the agent that ran it), else whichever is on PATH, `claude`
   first. The whole stage runs as one step. MCP servers, web tools and skills carry over; custom tools need path
   1 or 2, and the error names the variables that enable them. The CLI gets only an allowlisted environment,
   never the app's secrets. A stage's `model` (else `GTM_MODEL`) goes to the CLI when it is that CLI's family:
   `anthropic/…` as `claude --model`, `openai/…` as `codex -m`; any other model, or none, leaves the CLI on its
   own default. `reasoning` `none` and `minimal` run as `low` (neither CLI's default model has them).
   `maxSteps` does not apply.

`maxUsd` counts what is reported: on AI Gateway each call's cost plus tool costs; on an API key only tool costs
(providers report no price). After the call that reaches it, one last call without tools writes up the result.
On `claude` it is `--max-budget-usd`, which stops without a result, so the stage fails; `codex` reports no cost
and has no cap. A model call retries itself up to twice inside its step; the run does not retry it again.

## Models

`GTM_MODEL` wins. Otherwise the default follows `GTM_AGENT_BACKEND`: `claude` → the newest Claude Haiku,
anything else → GPT-6 Luna. Production gets the same variables, so hosted runs stay on that family (deploy.md).

Ids (one constant in the package): Claude Haiku 5.5 is Gateway `anthropic/claude-haiku-5.5`, Anthropic `claude-haiku-5-5`; GPT-6 Luna is Gateway `openai/gpt-6-luna`, OpenAI `gpt-6-luna`.

## Plan limits

The CLI path runs on the person's own subscription through the real, unmodified `claude`/`codex` binary and
never touches their login. Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page says developers building products or services on Claude, including with the Agent SDK, should use API
keys; that third-party developers may not route requests through Free, Pro or Max plan credentials on behalf
of their users; that this does not prevent an end user from signing in to the unmodified Claude Code binary
with their own subscription; and that plan limits "assume ordinary, individual usage of Claude Code and the
Agent SDK". So big batch runs may hit plan limits or draw attention to the account; `agent()` prints this once
per process. For big runs set a key or link Vercel (paths 1 and 2), which switches the CLI path off.

## Switching to real services

Environment variables alone switch services. After `vercel link`, `vercel env pull` writes the Development
environment into `.env.local`; it keeps local-only entries, and a Secret value it cannot read arrives as
Vercel's placeholder, which gtm treats as missing (add it again in Connections).

- Connect only a Neon dev branch to Development; a pulled `DATABASE_URL` replaces the local database.
- A pulled `VERCEL_OIDC_TOKEN` switches laptop `agent()` calls to AI Gateway (path 1), which bills the team.
  `vercel link` alone already writes one into `.env.local`; delete that line to stay on `claude`/`codex`.
- Never pull production's env to a laptop (`--environment=production`); production's stamped database is
  refused anyway (data.md). Remove `DATABASE_URL` from `.env.local` to go back to the local database.

## `GTM_ALLOWED_HOSTS`

Off by default. Comma-separated private hostnames (for example a Tailscale name, `box.tail1234.ts.net`) that
the local Console admits besides `127.0.0.1` and `localhost`, matched against the request's Host. gtm dev still
listens on 127.0.0.1 only; `tailscale serve --bg --https=<port> http://127.0.0.1:$GTM_PORT` forwards that name to it with the Host kept (checked).

**Warning: anyone on that private network gets in without a login**: they read Context and Data and can Save
keys into `.env.local` (or add, rename and delete connections), and Open database shares Drizzle Studio, which
edits every row, with the Tailscale login that presses it (data.md). Start and runs never answer on those hosts,
so nobody else can run stages on the owner's subscription; run workflows on this machine with
`npx @eliasstravik/gtm run`. The run inspector (`/api/gtm/inspector`) shows runs there but refuses replay, cancel
and every other change, and the Workflow SDK's own routes (`/.well-known/workflow/*`) answer 404: only this
server's queue calls them, on 127.0.0.1.
