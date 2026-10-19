# Deploy

The live project is the same repo as one Vercel project. `init` only writes files; the agent does every
account step with the vendors' own CLIs and dashboards. Our conventions:

1. **Vercel Pro.** Workflow run state is kept 7 days on Pro and 1 day on Hobby, so production needs Pro.
2. **Neon through the Vercel Marketplace**: production's branch on Production, preview branching (or no
   database) on Preview, a dev branch on Development. Never production's database on Development.
3. **Vercel Authentication on All Deployments** (`ssoProtection.deploymentType` `"all"`). The default Standard
   Protection (`"all_except_custom_domains"`) leaves production public. With All Deployments on, an
   unauthenticated request gets a 302 to `vercel.com/sso-api`. Until then every page and endpoint answers
   "Turn on Vercel Authentication → All Deployments" instead of content (checked per host, cached 5 minutes).
4. **"Automatically expose System Environment Variables" on.** gtm knows it is hosted from `VERCEL_ENV` plus
   `VERCEL_DEPLOYMENT_ID`.
5. **No Deployment Protection Exceptions and no Shareable Links**, ever.
6. **Teammates get Viewer invites** (free seats on Pro). Never approve access requests from outsiders: an
   approved requester can also Save keys.
7. **`CRON_SECRET`** on Production; the cron route refuses every call while it is unset.
8. **`GTM_AGENT_BACKEND`** (and `GTM_MODEL` if set) as Production Config variables, set by the agent with
   `vercel env add`, so hosted runs stay on the laptop's model family (local.md).
9. **The bypass secret for laptops**: the Protection Bypass for Automation secret (Project Settings →
   Deployment Protection, or the API) that deployments see as `VERCEL_AUTOMATION_BYPASS_SECRET`, copied to
   `.env.local` as `GTM_BYPASS_SECRET` with `GTM_PRODUCTION_URL` (`https://<production domain>`) for
   `npx @eliasstravik/gtm run --prod`. It reaches only `/api/gtm/start/*` and `/api/gtm/runs/*`. Only
   deployments built after it exists see it; redeploy once.
10. **One separate, labeled bypass secret per outside caller** (Slack, each webhook sender), never the one
    above, so each can be revoked alone (webhooks.md, slack.md).
11. **`GTM_VERCEL_TOKEN`**: created in the Vercel dashboard by the person setting up, scoped to this project
    only, with an expiry; saved as a Production Secret; never passed into the eve sandbox. Its expiry date goes
    in `GTM_VERCEL_TOKEN_EXPIRES` (ISO date) as a Production Config variable. Connections' hosted Save uses it
    (connections.md).
12. **`npx @eliasstravik/gtm check --prod`** before calling it live: an unauthenticated request to production
    must get Vercel's login, and the project must have no Exceptions and no Shareable Links (read through the
    Vercel API with `VERCEL_TOKEN` from the shell, else the logged-in `vercel` CLI's session).

## Notes

- `npm run build` is `gtm migrate && next build`, so every production deploy applies pending migrations first
  (data.md).
- Teammates add keys on the production domain (`VERCEL_PROJECT_PRODUCTION_URL`), the only place Save works.
- The README's Deploy button deploys `starter/` with Neon and no Slack agent; the rest of this list still
  applies (add the Slack agent later with `npx @eliasstravik/gtm init --slack`).
