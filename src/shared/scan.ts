/** What withGtm bakes into the build (GTM_CRONS) and the API rescans per request in dev. No pg. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Workflow schedules from `vercel.json` crons whose path is `/api/gtm/cron/<name>` (none if it is unreadable). */
export function cronSchedules(dir = process.cwd()): { workflow: string; schedule: string }[] {
  let crons: unknown;
  try { crons = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, "vercel.json"), "utf8")).crons; } catch { return []; }
  return (Array.isArray(crons) ? crons : []).flatMap((c: { path?: unknown; schedule?: unknown }) => {
    const m = /^\/api\/gtm\/cron\/([^/?#]+)(?:[?#].*)?$/.exec(String(c?.path));
    return m && typeof c.schedule === "string" ? [{ workflow: m[1], schedule: c.schedule }] : [];
  });
}
