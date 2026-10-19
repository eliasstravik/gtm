# Connections

A connection is an environment variable the company's workflows read: an API key or another value for one of
the company's own services. gtm stores no values anywhere of its own.

## `.env.example` is the list

- Every connection name is in `.env.example` with an empty value and a one-line description in a `#` comment
  directly above it. The Connections view shows each name, its description, and whether it is set here.
  A blank line between the comment and the name means no description; a commented-out `# NAME=` is not a connection.
- When a workflow needs a new key, add its name to `.env.example` in the same change.
- Values are never shown back, logged or stored by gtm. People add them in Connections; never ask for a value
  in chat.

## What Save accepts

- Only names listed in `.env.example`.
- One-line values that do not contain both `'` and `` ` `` and do not end in `\`.
- Always refused, even when listed: `DATABASE_URL*`, `POSTGRES_*`, `PG*`, `CRON_SECRET`, `GTM_*`, `VERCEL_*`,
  `SLACK_*`, `GITHUB_*`, `EVE_*`; hosted also `AI_GATEWAY_*`. The agent sets those with the vendor's CLI
  (for example `vercel env add`), or the integration sets them.

## Save locally

Writes the name to `.env.local`, the value in single quotes (backticks if it contains `'`) with `$` written as
`\$`, which Next's env loading reads back unchanged. The dev server reloads env; the status flips to set.
Same-origin requests only.

## Save hosted

- Only on the production domain (`VERCEL_PROJECT_PRODUCTION_URL`), because Vercel's login cookie is per
  domain. On any other domain Save is off and says to use the production domain.
- Only from a browser that passed Vercel Authentication (an owner session check plus a CSRF token); bypass,
  bearer and OIDC callers are refused.
- It writes the value straight to the project's Production environment as a Secret with `GTM_VERCEL_TOKEN`
  and redeploys the newest production deployment, showing its status. The new value is live once that
  redeploy is ready. Preview and Development values are set in the Vercel dashboard or with `vercel env add`.
- It refuses, with a dashboard link, a name that exists as one variable spanning several environments; split
  it in the dashboard first. It shows "production is pinned by a rollback" while production auto-assign is off.
- Without `GTM_VERCEL_TOKEN`, Save shows a link to the project's Vercel environment settings instead.
- From 14 days before `GTM_VERCEL_TOKEN_EXPIRES`, Connections shows a warning banner; replace the token
  (deploy.md).
- Anyone past Vercel's login (every Viewer) can change listed production keys; Vercel's log credits the
  token's owner.
