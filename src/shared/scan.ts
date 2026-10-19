/** What withGtm bakes into the build (GTM_PAGES, GTM_CRONS) and the API rescans per request in dev. No pg. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `app/` folders that are cockpit routes, never listed as agent-made pages. */
export const RESERVED_PAGES = ["context", "workflows", "data", "connections", "api", "eve", "_gtm"];

/**
 * Agent-made page slugs: every `app/<slug>/page.tsx` minus RESERVED_PAGES, sorted. Route groups, dynamic segments,
 * private and parallel folders ((x), [x], _x, @x) are not pages.
 */
export function pageSlugs(dir = process.cwd()): string[] {
  const app = join(/*turbopackIgnore: true*/ dir, "app");
  if (!existsSync(app)) return [];
  const page = (n: string) =>
    /^[a-z0-9]/i.test(n) && !RESERVED_PAGES.includes(n) && existsSync(join(/*turbopackIgnore: true*/ app, n, "page.tsx"));
  return readdirSync(app).filter(page).sort();
}

/** Workflow schedules from `vercel.json` crons whose path is `/api/gtm/cron/<name>` (none if it is unreadable). */
export function cronSchedules(dir = process.cwd()): { workflow: string; schedule: string }[] {
  let crons: unknown;
  try { crons = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, "vercel.json"), "utf8")).crons; } catch { return []; }
  return (Array.isArray(crons) ? crons : []).flatMap((c: { path?: unknown; schedule?: unknown }) => {
    const m = /^\/api\/gtm\/cron\/([^/?#]+)(?:[?#].*)?$/.exec(String(c?.path));
    return m && typeof c.schedule === "string" ? [{ workflow: m[1], schedule: c.schedule }] : [];
  });
}
