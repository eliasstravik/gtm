/**
 * "Open database". Hosted it links to Neon's console (or Vercel's Storage tab). Locally it starts Drizzle Studio on the
 * database the app uses, with the project's own drizzle-kit and drizzle.config.ts, once per dev server. Pressed on this
 * machine's Tailscale name, Studio is also shared with that same Tailscale login only: Serve on a free HTTPS port (never
 * Funnel) in front of a loopback gate. Studio and the share stop with the dev server.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { allowedHosts, assertNotProduction, isHosted, LOOPBACK_HOSTS, value } from "../shared/env.js";
import { requestHost } from "../shared/request.js";
import { HttpError, json } from "./http.js";
import { dashboardUrl } from "./vercel.js";

const STUDIO_PORT = 4983, SERVE_PORT = 8443, READY = /https:\/\/local\.drizzle\.studio/;
// Studio has an IPC channel to this server; when the server goes, however it goes, the channel closes and Studio exits.
const ORPHAN_GUARD = `data:text/javascript,process.once("disconnect",()=>process.exit())`;

type State = { url?: string; port?: Promise<number>; current?: number; child?: ChildProcess; owner?: string; share?: Promise<string>; hooked?: boolean };
// On globalThis, so a module reload in next dev still finds the one Studio.
const state: State = ((globalThis as { __gtmStudio?: State }).__gtmStudio ??= {});

/** /api/gtm/database → what the button does here; POST /api/gtm/database/open → Studio's address (local only). */
export async function database(req: Request, rest: string[]): Promise<Response> {
  const path = rest.join("/");
  if (path === "" && (req.method === "GET" || req.method === "HEAD")) return json(await destination());
  if (path === "open" && req.method === "POST") return json({ url: await open(req) });
  if (path === "" || path === "open") throw new HttpError(405, "Use GET /api/gtm/database or POST /api/gtm/database/open");
  throw new HttpError(404, `No such endpoint: /api/gtm/database/${path}`);
}

async function destination() {
  if (!isHosted()) return { mode: "local" };
  const neon = value("NEON_PROJECT_ID");
  if (neon) return { mode: "link", url: `https://console.neon.tech/app/projects/${encodeURIComponent(neon)}`, label: "Open in Neon", title: "This project's database in the Neon console" };
  // Neon accounts Vercel installed open Neon's console from the Storage tab.
  return { mode: "link", url: await dashboardUrl("/stores", "Storage"), label: "Open in Vercel", title: "Storage → Open in Neon" };
}

async function open(req: Request): Promise<string> {
  if (isHosted()) throw new HttpError(403, "Drizzle Studio opens only on a computer running gtm dev.");
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "Send JSON.");
  const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
  const originHost = origin && URL.canParse(origin) ? new URL(origin).host.toLowerCase() : "";
  if ((origin !== null && originHost !== requestHost(req)) || (site !== null && site !== "same-origin")) {
    throw new HttpError(403, "Open database accepts same-origin requests only.");
  }
  const host = requestHost(req).replace(/:\d+$/, ""), login = req.headers.get("tailscale-user-login")?.trim().toLowerCase();
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();
  const loopback = LOOPBACK_HOSTS.includes(host) && (!forwarded || LOOPBACK_HOSTS.includes(forwarded));
  if (!loopback && !allowedHosts().includes(host)) throw new HttpError(403, "Open database answers only on this computer.");
  const tailnet = !loopback && login && !req.headers.has("tailscale-funnel-request") && host === (await tailnetName());
  if (!loopback && !tailnet) {
    throw new HttpError(409, "Drizzle Studio opens on the computer running gtm dev: open the Console there (http://127.0.0.1) and press Open database.");
  }
  const url = value("DATABASE_URL");
  if (!url) throw new HttpError(503, "DATABASE_URL is not set; start the app with npm run dev (gtm dev).");
  await refuseProduction(url);
  const port = await studio(url);
  if (!tailnet) return `https://local.drizzle.studio/?port=${port}`;
  if (state.owner && state.owner !== login) throw new HttpError(409, "Studio is shared with another Tailscale login; restart gtm dev to share it with yours.");
  state.owner = login!;
  state.share ??= share(login!, host, Number(requestHost(req).split(":")[1] ?? 443)).catch((error) => {
    state.share = state.owner = undefined;
    throw error;
  });
  return state.share;
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
    process.once("exit", () => { state.child?.kill(); removeStudioShare(dir); });
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

const tailscale = (args: string[]) => new Promise<string>((done, fail) => execFile("tailscale", args, { timeout: 15_000 },
  (error, stdout, stderr) => (error ? fail(new Error(`tailscale ${args.join(" ")}: ${(stderr || error.message).trim()}`)) : done(stdout))));

/** This machine's tailnet name (`tailscale status` Self.DNSName without the dot), or undefined. */
const tailnetName = () => tailscale(["status", "--json"])
  .then((out) => String(JSON.parse(out).Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase() || undefined, () => undefined);

type ServeStatus = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
const shareFile = (dir: string) => join(/*turbopackIgnore: true*/ dir, ".gtm", "studio-share.json");

/**
 * Shares Studio on `host` with `owner` alone: a loopback gate, then Serve on the first HTTPS port no share uses (so
 * nothing already shared is replaced), checked to point there with Funnel off. Recorded in .gtm/ so gtm dev removes it.
 */
async function share(owner: string, host: string, consolePort: number): Promise<string> {
  const dir = process.cwd();
  removeStudioShare(dir); // one a crash left behind
  const gate = await studioGate(owner);
  try {
    const status = async () => JSON.parse((await tailscale(["serve", "status", "--json"])) || "{}") as ServeStatus;
    const used = new Set(Object.keys((await status()).TCP ?? {}).map(Number)).add(consolePort);
    let https = SERVE_PORT;
    while (used.has(https)) https++;
    const target = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`, key = `${host}:${https}`;
    await tailscale(["serve", "--bg", `--https=${https}`, target]);
    mkdirSync(join(/*turbopackIgnore: true*/ dir, ".gtm"), { recursive: true });
    writeFileSync(shareFile(dir), JSON.stringify({ host, https, target }));
    const after = await status();
    if (after.Web?.[key]?.Handlers?.["/"]?.Proxy !== target || after.AllowFunnel?.[key]) {
      removeStudioShare(dir);
      throw new Error("Tailscale Serve did not take the share as a tailnet-only proxy to Studio.");
    }
    return `https://local.drizzle.studio/?host=${host}&port=${https}`;
  } catch (error) {
    gate.close();
    throw new HttpError(502, `Could not share Drizzle Studio on the tailnet. ${(error as Error).message}`);
  }
}

/** A loopback relay to Studio that lets through only requests Serve marks with `owner`'s login, never Funnel ones. */
async function studioGate(owner: string): Promise<Server> {
  const server = httpServer((req, res) => {
    const login = String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
    if (req.headers["tailscale-funnel-request"] || login !== owner || !state.current) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Only the Tailscale login that pressed Open database gets in.");
      return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: state.current, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.once("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end("Drizzle Studio is not running.")));
    req.pipe(upstream);
  });
  await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
  server.unref();
  return server;
}

/** Removes the recorded Studio share while Serve still points it at the recorded gate. Sync, never throws (gtm dev runs it on exit). */
export function removeStudioShare(dir: string): void {
  let s: { host: string; https: number; target: string };
  try { s = JSON.parse(readFileSync(shareFile(dir), "utf8")); } catch { return; }
  try {
    const run = (args: string[]) => spawnSync("tailscale", args, { encoding: "utf8", timeout: 15_000 });
    const status = JSON.parse(run(["serve", "status", "--json"]).stdout || "{}") as ServeStatus;
    const ours = status.Web?.[`${s.host}:${s.https}`]?.Handlers?.["/"]?.Proxy === s.target;
    if (!ours || run(["serve", `--https=${s.https}`, "off"]).status === 0) rmSync(shareFile(dir), { force: true });
  } catch {}
}
