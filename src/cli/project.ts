import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import type { Env } from "../shared/env.js";

/** The installed package's root (holds starter/, docs/, migrations/). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The nearest folder at or above `from` that holds a gtm project (package.json depending on @eliasstravik/gtm). */
export function findProject(from = process.cwd()): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "proxy.ts")) && existsSync(join(dir, "workflows"))) return dir;
    if (dirname(dir) === dir) throw new Error("No gtm project here. Create one with `npx @eliasstravik/gtm init <dir>`.");
  }
}

/** Loads .env files exactly as Next does (shell wins) into process.env and returns it. */
export function loadEnv(dir: string, dev: boolean): Env {
  nextEnv.loadEnvConfig(dir, dev, { info: () => {}, error: console.error }, true);
  return process.env;
}
