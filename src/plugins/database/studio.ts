/**
 * "Open database". Hosted it links to Neon's console (or Vercel's Storage tab). Locally it starts Drizzle Studio on the
 * database the app uses, with the project's own drizzle-kit and drizzle.config.ts, once per dev server, on 127.0.0.1
 * only. Studio stops with the dev server.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { assertNotProduction, HttpError, isHosted, json, loopback, value } from "@eliasstravik/gtm/kit";

const STUDIO_PORT = 4983, READY = /https:\/\/local\.drizzle\.studio/;
// Studio has an IPC channel to this server; when the server goes, however it goes, the channel closes and Studio exits.
const ORPHAN_GUARD = `data:text/javascript,process.once("disconnect",()=>process.exit())`;

type State = { url?: string; port?: Promise<number>; current?: number; child?: ChildProcess; hooked?: boolean };
// On globalThis, so a module reload in next dev still finds the one Studio.
const state: State = ((globalThis as { __gtmStudio?: State }).__gtmStudio ??= {});

/** GET /database (session) → what the button does here: `{ mode: "local" }` on this computer (none for allowed hosts), or
 * a link to the database's console. */
export async function destination(req: Request): Promise<Response> {
  if (!isHosted()) return json({ mode: loopback(req) ? "local" : "none" });
  const neon = value("NEON_PROJECT_ID");
  if (neon) return json({ mode: "link", url: `https://console.neon.tech/app/projects/${encodeURIComponent(neon)}`, label: "Open in Neon", title: "This project's database in the Neon console" });
  // Neon accounts Vercel installed open Neon's console from the Storage tab.
  const to = encodeURIComponent("/[team]/[project]/stores");
  return json({ mode: "link", url: `https://vercel.com/d?to=${to}&title=Storage`, label: "Open in Vercel", title: "Storage → Open in Neon" });
}

/** POST /database/open (local) → { url }: Drizzle Studio's address on this computer. */
export async function open(req: Request): Promise<Response> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "Send JSON.");
  const url = value("DATABASE_URL");
  if (!url) throw new HttpError(503, "DATABASE_URL is not set; start the app with npm run dev (gtm dev).");
  await refuseProduction(url);
  return json({ url: `https://local.drizzle.studio/?port=${await studio(url)}` });
}

async function refuseProduction(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await assertNotProduction(async (sql) => (await client.query(sql)).rows, url);
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Studio's port: the running one, or a new Studio on the first free port from 4983 (restarted when DATABASE_URL moved). */
function studio(url: string): Promise<number> {
  if (state.url !== url) { state.child?.kill(); state.child = state.port = state.current = undefined; }
  state.url = url;
  state.port ??= start(url).then((port) => (state.current = port), (error) => {
    state.port = undefined;
    throw error;
  });
  return state.port;
}

async function start(url: string): Promise<number> {
  const dir = process.cwd(), kit = join(/*turbopackIgnore: true*/ dir, "node_modules", "drizzle-kit");
  let bin: string | Record<string, string>;
  try { ({ bin } = JSON.parse(readFileSync(join(kit, "package.json"), "utf8"))); } catch {
    throw new HttpError(503, "drizzle-kit is not installed in this project: run `npm install`.");
  }
  const port = await freePort(STUDIO_PORT);
  const child = spawn(process.execPath, ["--import", ORPHAN_GUARD, join(kit, typeof bin === "string" ? bin : bin["drizzle-kit"]),
    "studio", "--host", "127.0.0.1", "--port", String(port)], { cwd: dir, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  state.child = child;
  if (!state.hooked) {
    state.hooked = true;
    process.once("exit", () => state.child?.kill());
  }
  return new Promise<number>((done, fail) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); fail(new HttpError(503, "Drizzle Studio did not start within 30 s.")); }, 30_000);
    const read = (chunk: Buffer) => {
      output = (output + chunk).replace(/\x1b\[[0-9;]*m/g, "").slice(-4000); // colour codes off before matching
      if (READY.test(output)) { clearTimeout(timer); done(port); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", () => {
      clearTimeout(timer);
      if (state.child === child) state.child = state.port = state.current = undefined;
      const reason = output.trim().split("\n").at(-1);
      fail(new HttpError(503, `Drizzle Studio stopped${reason ? `: ${reason}` : "."}`));
    });
  });
}

/** The first port from `from` that 127.0.0.1 can listen on. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 20; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new HttpError(503, `No free port for Drizzle Studio (tried ${from}–${from + 19}).`);
}
