# Recipe: enrich companies

Reads each company saved by [import-list](../import-list/README.md) from its own website, with one AI step per
company, into a `company_profiles` row: description, industry, business type and location. Needs no API key: the
AI step uses the project's model backend (local.md). Data shows `company_profiles` next to `companies`.

## Files

- `workflows/enrich-companies.ts`: copy as is.
- `schema.ts`: append to `db/schema.ts` (after import-list's table, which it reads).
- Registry entry in `workflows/index.ts` (with `import { enrichCompanies } from "./enrich-companies";`):

```ts
"enrich-companies": {
  run: enrichCompanies,
  description: "Reads each saved company's website into a short profile: what it does, its industry and where it is.",
  tables: ["company_profiles"],
  diagram: {
    nodes: [
      { id: "pick", label: "Companies without a recent profile", kind: "input", explanation: "Up to 20 per run from companies, oldest first." },
      { id: "read", label: "Read the website", kind: "action", explanation: "An AI step reads the company's own site.", details: { Model: "the project's default" } },
      { id: "save", label: "Save the profile", kind: "output", explanation: "One row per domain in company_profiles." },
    ],
    edges: [{ source: "pick", target: "read" }, { source: "read", target: "save" }],
  },
},
```

## How to

1. Copy the files, then `npm run db:generate` and `npm run db:migrate`.
2. Preview: `npx @eliasstravik/gtm run enrich-companies --input '{"limit":3}'`. Show its sample and quote the cost
   of the rest (the preview's `costUsd` or `usage` × the companies left; workflows.md, cost quotes), then ask.
3. After a yes, run it without input; each run takes up to 20 companies, so a longer list takes several runs, or a
   weekly schedule (`vercel.json`, workflows.md).

A paid enrichment service instead of the website: ask which one, read its documentation, call it from a step
with its key in `.env.example`, and keep the same table. Never pick a vendor for the person.
