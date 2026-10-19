# Pages

Anything beyond the four built-in views (Context, Workflows, Data, Connections) is an ordinary app page the
agent adds. The built-in views stay generic; GTM-specific screens are agent-made pages.

## Agent-made pages

- Any `app/<slug>/page.tsx` is listed under "Pages" in the cockpit menu. Locally the menu rescans per request,
  so a new page shows without restarting `npm run dev`; hosted, the list is fixed at build time.
- Only top-level `app/<slug>/page.tsx` files are listed. Never use a reserved slug: `context`, `workflows`,
  `data`, `connections`, `api`, `eve`, `_gtm`.
- Pages get the cockpit shell from `app/layout.tsx` and the proxy's guards: loopback (or `GTM_ALLOWED_HOSTS`)
  locally, Vercel Authentication and the fail-closed check hosted. Add no login of your own.
- Pages never start runs (hosted, `/api/gtm/start` refuses browser sessions); runs start from chat
  (workflows.md).

## Pages that read data

A page that calls `db()` must be dynamic:

```tsx
export const dynamic = "force-dynamic";
```

Without it `db()` throws "pages that read data must be dynamic" during `next build`. Read through `db()` in a
server component; there is no SQL endpoint for pages.

## Components

`import { Table, Markdown } from "@eliasstravik/gtm/ui"` gives the cockpit's own components, so agent pages
look like the built-in views:

- `<Table columns={["name", "score"]} rows={[["Acme", 7]]} />`: the Data view's table; `rows` may also be objects (columns then come from their keys). Dates, bigints and objects render as text. Works in server and client components.
- `<Markdown source={text} />`: the Context view's read-only renderer; raw HTML in the source shows as text.
