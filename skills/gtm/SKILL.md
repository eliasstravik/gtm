---
name: gtm
description: Sets up and maintains a company's go-to-market (GTM) project on @eliasstravik/gtm, one Next.js repo and Vercel project named after the company (gtm-acme for Acme) that holds what the company knows, its workflows, Console, connections and optional Slack agent. Triggers when someone asks to set up GTM for a company ("set up GTM for Acme", "create gtm-acme"), to add or change the company's context, to build, preview, run or schedule outbound, enrichment, scoring or other GTM workflows, to open or extend the Console, to add a connection or API key, to deploy the project to Vercel or add its Slack agent, and on any work inside a folder whose package.json depends on @eliasstravik/gtm. Not for unrelated web apps, marketing websites, generic Next.js projects, one-off CRM scripts outside a gtm project, or changes to the @eliasstravik/gtm package itself.
---

# gtm

## Trigger

Apply when a person asks to create, change, run or deploy a company's gtm project, or works inside one.

## Scope

Owns one company's gtm project, `gtm-<company>`, from `init` through every later change: context, workflows,
Console, connections, deploy and the Slack agent. Company know-how lives in that repo, never in this skill, and this
skill is never installed into it.

## Inputs

- The person's request and the company's name.
- The project's `AGENTS.md`; its managed block holds the rules of the installed version.
- The installed docs: `npx @eliasstravik/gtm docs <topic>`, or `node_modules/@eliasstravik/gtm/docs/`.

## Roles

- The coding agent edits the repo, runs the `gtm` CLI and does account steps with the vendors' own CLIs.
- The person decides what gets added, gives every yes in chat and enters every secret value in Connections or a
  vendor CLI; never ask for a value in chat.

## Procedure

Talk by [the interaction rules](references/interaction.md); reproduce [the dialogues](references/interactions.md).

1. Find the project: the nearest folder at or above this one whose `package.json` depends on `@eliasstravik/gtm`.
2. With none, run `npx @eliasstravik/gtm init --company <Company>`, which creates `./gtm-<company>` here with base
   files only; add `--slack` when the Slack agent is wanted, and `--example` only when the person asks for a demo.
   Run `init . --company <Company>` instead only when this folder is the project's own `gtm-<company>` folder and
   holds nothing but `.git`, `.agents/`, `.claude/`, `AGENTS.md` or `CLAUDE.md`. Then write only the basics into
   `context/company.md`: the name as its heading and a short description from what the person said, or a quick look
   at the company's site when they gave one. Ask what to add next and stop until they answer.
3. Otherwise read `AGENTS.md`, then the docs topic of the job before changing anything:

   | Job | Topics |
   | --- | --- |
   | Add or change context the person asked for | context |
   | Add or change a company skill (in `.agents/skills/<name>/SKILL.md` only) | layout |
   | Build, change, preview, run or schedule a workflow | workflows, data, recipes (copy one only when asked) |
   | Open the Console (`npm run dev`) or change project files | layout, local |
   | Add a connection or API key | connections |
   | Go live on Vercel | deploy |
   | Inbound webhooks | webhooks |
   | Slack agent (`init --slack`) | slack |

4. Before a risky or costly run, run its preview, show the sample and the cost quote in this chat, and start the
   real run only after a yes here.
5. Run `npx @eliasstravik/gtm check` and fix what it lists; run `npx @eliasstravik/gtm init` inside the project to
   restore missing wiring and refresh the `AGENTS.md` block.

## Outputs

Changes in the company's `gtm-<company>` repo and, for deploy steps, its Vercel project of the same name.

## Exceptions

- `init` refuses an existing non-gtm Next.js app and a non-empty folder; offer a new `gtm-<company>` folder instead.
- Where this file and the installed docs disagree, the docs win; they match the installed version.

## QC

- After setup, `context/` holds only `company.md` with the name and a short description until the person asks for more.
- Every AI call in a workflow, one-shot or tool-using, is `agent()`: no `ai` or `@ai-sdk/*` import, no
  `generateText`/`generateObject`/`streamText`/`WorkflowAgent`, no model id in workflow code (`GTM_MODEL` picks it).
- A company skill is a folder in `.agents/skills/` with a `SKILL.md` (`name`, `description`), created there and
  not through `.claude/skills` or `agent/skills`.
- `npx @eliasstravik/gtm check` exits 0 after every change, and `check --prod` before a deploy is called live.
- No real run of a risky or costly workflow started without a yes in chat.

## References

[interaction](references/interaction.md) rules and [interactions](references/interactions.md) dialogues; the
project's `AGENTS.md`; `npx @eliasstravik/gtm docs [topic]`, where `context` holds the suggested context layout.
