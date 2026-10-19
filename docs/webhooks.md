# Webhooks

Inbound webhooks (email replies, CRM events, form submissions) live at `app/api/hooks/<sender>/route.ts`, one
folder per sender.

## The sender's URL

- Production only: `https://<production domain>/api/hooks/<sender>`, carrying that sender's own labeled
  bypass secret, as the `x-vercel-protection-bypass` header or, when the sender cannot set headers, the
  `x-vercel-protection-bypass` query parameter.
- Create one bypass secret per sender, labeled with the sender's name, so it can be revoked alone. Never give
  a sender the one deployments see as `VERCEL_AUTOMATION_BYPASS_SECRET`; the proxy refuses that value here.
- Bypass-carrying requests reach only `/api/hooks/*` (and Slack's `/eve/v1/slack`), never pages or cockpit
  read endpoints, so a vendor holding its URL cannot read Data or Context.
- `/api/hooks/*` carries its own check, so it is exempt from the fail-closed notice.

## Every handler

- Verifies the sender's signature with the sender's signing secret and refuses (4xx) when that secret is
  unset or is Vercel's pull placeholder, the literal `[SENSITIVE]` that `vercel env pull` writes for a Secret.
- Only records (a row in a workflow-owned table through `db()`) or starts a registered workflow; all other
  work happens in the run.
- The signing secret's name goes in `.env.example` like any connection (connections.md). Names Save refuses
  (`SLACK_*`, `GITHUB_*`, …) are set with `vercel env add`.

## Locally

Like every route, `/api/hooks/*` answers only `127.0.0.1`, `localhost` and `GTM_ALLOWED_HOSTS`, and refuses a
cross-site browser POST.
