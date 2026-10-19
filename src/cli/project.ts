import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import type { Env } from "../shared/env.js";

/** The installed package's root (holds starter/, docs/, migrations/, slack/). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Parsed JSON file, or undefined when it is missing or unreadable. */
export function readJson<T = any>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

/** True when `dir` holds a gtm project: a package.json that depends on @eliasstravik/gtm. */
export function isGtmProject(dir: string): boolean {
  const pkg = readJson(join(dir, "package.json"));
  return Boolean(pkg?.dependencies?.["@eliasstravik/gtm"] ?? pkg?.devDependencies?.["@eliasstravik/gtm"]);
}

/** The nearest folder at or above `from` that holds a gtm project (package.json depending on @eliasstravik/gtm). */
export function findProject(from = process.cwd()): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (isGtmProject(dir)) return dir;
    if (dirname(dir) === dir) throw new Error("No gtm project here. Create one with `npx @eliasstravik/gtm init <dir>`.");
  }
}

/** Loads .env files exactly as Next does (shell wins) into process.env and returns it. */
export function loadEnv(dir: string, dev: boolean): Env {
  nextEnv.loadEnvConfig(dir, dev, { info: () => {}, error: console.error }, true);
  return process.env;
}

/** Files `gtm init` restores in an existing project when they are missing (plan §3), besides the skills links. */
export const RESTORED = ["proxy.ts", "app/[[...path]]/page.tsx", "app/api/gtm/[...path]/route.ts", "public/_gtm/probe.txt"];

/** Where the company's skills are linked from (relative to the project); `agent/skills` only when agent/ exists. */
export function skillLinks(dir: string): string[] {
  return existsSync(join(dir, "agent")) ? [".claude/skills", "agent/skills"] : [".claude/skills"];
}

/** The target every skills link points at, relative to the link's folder. */
export const SKILLS_TARGET = "../.agents/skills";

const BEGIN = "<!-- BEGIN:gtm -->";
const END = "<!-- END:gtm -->";

/** The managed AGENTS.md block, markers included, or undefined when `text` has none. */
export function extractBlock(text: string): string | undefined {
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  return end < 0 ? undefined : text.slice(start, end + END.length).replace(/\r\n/g, "\n");
}

/** This version's managed block; its single source is starter/AGENTS.md. */
export function managedBlock(): string {
  const block = extractBlock(readFileSync(join(packageRoot(), "starter", "AGENTS.md"), "utf8"));
  if (!block) throw new Error("starter/AGENTS.md has no managed block");
  return block;
}

/** `text` with its managed block replaced by this version's, or with the block appended when it has none. */
export function withBlock(text: string): string {
  const block = managedBlock();
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  if (end >= 0) return text.slice(0, start) + block + text.slice(end + END.length);
  return (text.trim() ? `${text.trimEnd()}\n\n` : "") + `${block}\n`;
}
