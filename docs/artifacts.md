# Artifacts

Anything beyond the four built-in views (Context, Workflows, Data, Connections) is an artifact: an ordinary app
page the agent adds. The built-in views stay generic; GTM-specific screens are artifacts.

## Artifacts

- Any `app/<slug>/page.tsx` is listed under "Artifacts" in the cockpit's sidebar, labelled from its slug
  (`app/reply-rates/page.tsx` → "Reply rates"). Locally the list rescans per request, so a new artifact shows
  without restarting `npm run dev`; hosted, the list is fixed at build time.
- Only top-level `app/<slug>/page.tsx` files are listed. Never use a reserved slug: `context`, `workflows`,
  `data`, `connections`, `api`, `eve`, `_gtm`.
- Artifacts get the cockpit shell from `app/layout.tsx` and the proxy's guards: loopback (or
  `GTM_ALLOWED_HOSTS`) locally, Vercel Authentication and the fail-closed check hosted. Add no login of your own.
- Artifacts never start runs (hosted, `/api/gtm/start` refuses browser sessions); runs start from chat
  (workflows.md).

## Artifacts that read data

An artifact that calls `db()` must be dynamic:

```tsx
export const dynamic = "force-dynamic";
```

Without it `db()` throws "pages (artifacts) that read data must be dynamic" during `next build`. Read through
`db()` in a server component; there is no SQL endpoint for artifacts.

## Components

`import { Table, Markdown } from "@eliasstravik/gtm/ui"` gives the cockpit's own components, so artifacts look
like the built-in views:

- `<Table columns={["name", "score"]} rows={[["Acme", 7]]} />`: the Data view's table; `rows` may also be objects (columns then come from their keys). Dates, bigints and objects render as text. Works in server and client components.
- `<Markdown source={text} />`: the Context view's read-only renderer; raw HTML in the source shows as text.
