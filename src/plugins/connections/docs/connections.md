# Connections

A connection is an environment variable the company's workflows read: an API key or another value for one of
the company's own services. gtm stores no values anywhere of its own.

## The list

- `.env.example` keeps every connection name in the repo, with an empty value and a one-line label in a `#`
  comment directly above it. A blank line between the comment and the name means no label; a commented-out
  `# NAME=` is not a connection. When a workflow needs a new key, add its name there in the same change.
- The Connections view lists `.env.example`'s names, the names a workflow declares in its registry entry's
  `connections`, and the names already set: locally in `.env.local`, hosted in Vercel's Production environment
  (read live with `GTM_VERCEL_TOKEN`). Names Save refuses (below) are listed only from `.env.example`.
- Each row shows the label (hosted, the Vercel variable's comment first), the name, its state here (Set,
  Missing, Saved, Provided by Vercel, Read only) and the workflows using it ("Used by", "Needed by" for a
  missing one). Missing ones come first.
- Values are never shown back, logged or stored by gtm. People add them in Connections; never ask for a value
  in chat.

## Add, Edit, Delete

- **Add connection** takes a name (the label), a key (letters, digits and `_`, not starting with a digit) and
  a value. A key that is already set is changed with Edit instead. A missing row has its own Add.
- **Edit** (the row's ⋯ menu) changes the label, the value, or both; the key stays. An empty value keeps the
  old one.
- **Delete** asks first and names the workflows using the key; they stop working until it is added again.
- **Refresh** reads the list again. A value typed in a form is cleared when the form closes or the page is left.

What every change accepts:

- One-line values that do not contain both `'` and `` ` `` and do not end in `\`; labels of one line, at most
  256 characters.
- Never these names: `DATABASE_URL*`, `POSTGRES_*`, `PG*`, `CRON_SECRET`, `GTM_*`, `VERCEL_*`, `SLACK_*`,
  `GITHUB_*`, `EVE_*`; hosted also `AI_GATEWAY_*`. The agent sets those with the vendor's CLI (for example
  `vercel env add`), or the integration sets them. Listed in `.env.example`, they show without actions.

## Locally

- Add and Edit write the value to `.env.local`, in single quotes (backticks if it contains `'`) with `$`
  written as `\$`, which Next's env loading reads back unchanged. A new name is also appended to `.env.example`
  as `# <label>` and `NAME=`; a label change rewrites (or inserts) the comment directly above the name.
- Delete removes the name from `.env.local`, and the name with its comment from `.env.example`.
- Both files are written whole and renamed into place; `.env.local` stays readable by its owner only. Other
  lines are kept. The dev server reloads env within seconds and the row turns Set.
- Same-origin requests only.
- A key set in the shell that started `gtm dev` wins over `.env.local`: its row says so, and a change in
  Connections applies only once the shell stops setting it and gtm dev restarts.

## Hosted

- Changes work only on the production domain (`VERCEL_PROJECT_PRODUCTION_URL`), because Vercel's login cookie
  is per domain, and only from a browser that passed Vercel Authentication (an owner session check plus a CSRF
  token); bypass, bearer and OIDC callers are refused. On any other domain the list is read-only.
- Add and Edit write the value straight to the project's Production environment as a Secret, with the label as
  its comment, then redeploy the newest production deployment; the environment badge follows that redeploy.
  A label-only Edit changes the comment and redeploys nothing. Delete removes the Production variable and
  redeploys. Preview and Development values are set in the Vercel dashboard or with `vercel env add`.
- When the redeploy fails, or is skipped because a rollback pins production, a notice offers **Redeploy**,
  which redeploys again without sending any value.
- A variable shared with other environments, one an integration or Vercel owns, and a system one show Read
  only, with Open in Vercel; change them in the dashboard. `AI_GATEWAY_*` names show Provided by Vercel: the
  deployment's OIDC identity stands in for them.
- Without `GTM_VERCEL_TOKEN`, Connections shows a link to the project's Vercel environment settings instead.
- From 14 days before `GTM_VERCEL_TOKEN_EXPIRES`, Connections shows a warning banner; replace the token
  (deploy.md).
- Anyone past Vercel's login (every Viewer) can change production keys; Vercel's log credits the token's owner.
