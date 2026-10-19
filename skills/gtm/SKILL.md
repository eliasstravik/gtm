---
name: gtm
description: Sets up and maintains a company's go-to-market (GTM) project built on @eliasstravik/gtm, one Next.js repo on Vercel holding the company's context, workflows, cockpit and connections. Triggers when someone asks to set up GTM for a company ("set up GTM for Acme"), to write or change ICPs, personas or voice, to build, run or schedule outbound, enrichment or other GTM workflows, to open or extend the cockpit, to add connections or API keys, to deploy the GTM project or add its Slack agent, and on any work inside a folder that already holds a gtm project. Not for unrelated web apps, marketing websites, generic Next.js projects or one-off CRM scripts outside a gtm project.
---

# gtm

## Trigger

Apply when a person asks to create, change, run or deploy a company's gtm project, or works inside one.

## Scope

Owns one company's gtm project, a repo depending on `@eliasstravik/gtm`, from `init` through every later change.
Company know-how lives in that repo, never in this skill.

## Inputs

The person's request and company name, the project's `AGENTS.md`, and the docs of the installed package version.

## Roles

The coding agent edits the repo and does account steps with vendor CLIs; the person decides and gives every yes in chat.

## Procedure

1. With no gtm project here, run `npx @eliasstravik/gtm init <dir>`, using `.` when this folder holds only `.git`, `.agents/`, `.claude/`, `AGENTS.md` or `CLAUDE.md`.
2. Otherwise read `AGENTS.md`, then the topic in `node_modules/@eliasstravik/gtm/docs/` (or `npx @eliasstravik/gtm docs <topic>`) before changing layout, workflows, data, connections, pages, deploy, webhooks or Slack.
3. Never rely on this file for details; the installed docs match the installed version.

## Outputs

Changes in the company's gtm project only; this skill is never installed into it.

## Exceptions

`init` refuses to add gtm to an existing non-gtm Next.js app; offer a new project folder instead.

## QC

`npx @eliasstravik/gtm check` exits 0 after every change.

## References

The project's `AGENTS.md` and `npx @eliasstravik/gtm docs [topic]`.
