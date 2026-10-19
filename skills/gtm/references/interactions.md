# Interactions: gtm

Contents: [Set up](#set-up) · [Add context when asked](#add-context-when-asked) · [Risky run](#risky-run)

The numbered choices stand for the host's native question tool.

## Set up

**Setup:** No gtm project in this folder.

**Human:** Set up GTM for Acme. We sell product analytics to SaaS teams, acme.example.

**Agent:** Creating the Acme project with the basics: its name and a short description from that and a quick look at
acme.example; about a minute.

Created Acme's project. Its description says Acme sells product analytics to SaaS teams. What next?

1. Describe who to sell to (Recommended)
2. Add the buyers to reach
3. Build a first workflow
4. Something else

**Human:** Nothing for now.

**Agent:** Saved. Acme's project is ready whenever there is more to add.

**Files:**
- created the project folder `gtm-acme/` (`init --company Acme`)
- changed `context/company.md` (heading and description only)

## Add context when asked

**Setup:** Project gtm-acme exists with only `context/company.md`.

**Human:** Add our ICP: B2B SaaS companies, 50 to 200 people, US or UK, on HubSpot.

**Agent:** Creating the ICP B2B SaaS: B2B software, 51–200 employees, US or UK, HubSpot. The other criteria stay
Unknown until supplied; Acme's own facts do not define prospect criteria.

Created B2B SaaS. What next?

1. Add the buyers to reach (Recommended)
2. Build a workflow that scores companies against it
3. Nothing for now

**Files:**
- created `context/icps/b2b-saas.md` (shape from `gtm docs context`)

## Risky run

**Setup:** The workflow Score inbound accounts calls a paid enrichment API per row.

**Human:** Run Score inbound accounts on last month's 800 signups.

**Agent:** The 10-row preview scored 7 of 10 as a fit; the full run of 800 costs about $12 in enrichment and model
calls. Start it?

Options: Yes; No.

**Human:** Yes.

**Agent:** Running Score inbound accounts on 800 signups; about 20 minutes.

Done. 512 of 800 fit; the Data view's qualified_companies table has every verdict.
