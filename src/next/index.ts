import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { allowedHosts } from "../shared/env.js";

type Phase = string;
type Context = { defaultConfig: NextConfig };
type ConfigInput = NextConfig | ((phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>);

/** `app/` folders that are cockpit routes, never listed as agent-made pages. */
export const RESERVED_PAGES = ["context", "workflows", "data", "connections", "api", "eve", "_gtm"];
const TRACED = ["./context/**", "./.agents/skills/**", "./AGENTS.md", "./.env.example", "./vercel.json"];

/**
 * Agent-made page slugs: every `app/<slug>/page.tsx` minus RESERVED_PAGES, sorted. Route groups, dynamic segments,
 * private and parallel folders ((x), [x], _x, @x) are not pages. Same rule as the API's dev rescan.
 */
export function pageSlugs(dir = process.cwd()): string[] {
  const app = join(dir, "app");
  if (!existsSync(app)) return [];
  return readdirSync(app).filter((n) => /^[a-z0-9]/i.test(n) && !RESERVED_PAGES.includes(n) && existsSync(join(app, n, "page.tsx")))
    .sort();
}

/** Workflow schedules from `vercel.json` crons whose path is `/api/gtm/cron/<name>` (none if it is unreadable). */
export function cronSchedules(dir = process.cwd()): { workflow: string; schedule: string }[] {
  let crons: unknown;
  try { crons = JSON.parse(readFileSync(join(dir, "vercel.json"), "utf8")).crons; } catch { return []; }
  return (Array.isArray(crons) ? crons : []).flatMap((c: { path?: unknown; schedule?: unknown }) => {
    const m = /^\/api\/gtm\/cron\/([^/?#]+)(?:[?#].*)?$/.exec(String(c?.path));
    return m && typeof c.schedule === "string" ? [{ workflow: m[1], schedule: c.schedule }] : [];
  });
}

function gtmConfig(user: NextConfig, dir: string): NextConfig {
  const includes = { ...user.outputFileTracingIncludes };
  includes["/**/*"] = [...new Set([...(includes["/**/*"] ?? []), ...TRACED])];
  return {
    ...user,
    outputFileTracingIncludes: includes,
    allowedDevOrigins: [...new Set([...(user.allowedDevOrigins ?? []), ...allowedHosts()])],
    // Read at runtime as the literal `process.env.GTM_CRONS` / `process.env.GTM_PAGES` (Next inlines them).
    env: { ...user.env, GTM_CRONS: JSON.stringify(cronSchedules(dir)), GTM_PAGES: JSON.stringify(pageSlugs(dir)) },
  };
}

/** eve is an optional peer: resolve it from the project, never from this package. */
async function loadWithEve(dir: string) {
  let path: string;
  try { path = createRequire(join(dir, "package.json")).resolve("eve/next"); }
  catch { throw new Error("agent/ exists but the eve package is not installed. Run `npm install eve@0.80.1`."); }
  const eve = (await import(pathToFileURL(path).href)) as {
    withEve: (config: never) => (phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>;
  };
  return eve.withEve;
}

/**
 * The company's Next.js config: Workflow SDK always, eve when `agent/` exists, plus gtm's file tracing, allowed dev
 * origins (GTM_ALLOWED_HOSTS) and build-time GTM_CRONS / GTM_PAGES. Everything else in `config` is kept as is.
 * Composed as withEve(withWorkflow(config)), the order spike 1b deployed; the reverse fails eve's types.
 */
export function withGtm(config: ConfigInput = {}) {
  return async (phase: Phase, ctx: Context): Promise<NextConfig> => {
    const dir = process.cwd();
    const user = typeof config === "function" ? await config(phase, ctx) : config;
    // Next 16 writes its own block into AGENTS.md on `next dev`; the file is the company's plus our managed block.
    const workflow = withWorkflow({ agentRules: false, ...gtmConfig(user, dir) });
    if (!existsSync(join(dir, "agent"))) return workflow(phase, ctx);
    return (await loadWithEve(dir))(workflow as never)(phase, ctx);
  };
}
