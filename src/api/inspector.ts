/**
 * The Workflow SDK's own run inspector (`@workflow/web`), served by the local Console under /api/gtm/inspector:
 * `/api/gtm/inspector` lists runs, `/api/gtm/inspector/run/<id>` shows one. Never hosted (Vercel's dashboard is).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isHosted } from "../shared/env.js";
import { HttpError } from "./http.js";

const BASE = "/api/gtm/inspector";
/** RPC methods that only read. The rest (cancel, re-run, re-enqueue, wake up, resume a hook, health check, hook tokens, keys) change runs or hand out secrets. */
const READS = ["fetchRuns", "fetchRun", "fetchStep", "fetchEvents", "fetchEvent", "fetchEventsByCorrelationId", "fetchHooks",
  "fetchHook", "fetchStreams", "fetchWorkflowsManifest", "getPublicServerConfig"];
const REFUSED = "Runs change only on the computer running gtm: open the Console at 127.0.0.1 or localhost there, or use `npx @eliasstravik/gtm run`.";

type Handler = (req: Request) => Promise<Response>;
let handler: Promise<Handler> | undefined;

/** @workflow/web through the project's `workflow` dependency (its CLI or Nitro package), so gtm adds no dependency. */
function load(): Promise<Handler> {
  handler ??= (async () => {
    const from = (base: string, id: string) => createRequire(base).resolve(id);
    const workflow = from(join(process.cwd(), "package.json"), "workflow");
    let url: string | undefined;
    for (const via of ["@workflow/cli/package.json", "@workflow/nitro"]) {
      try { url = pathToFileURL(from(from(workflow, via), "@workflow/web/handler")).href; break; } catch {}
    }
    if (!url) throw new Error("The run inspector (@workflow/web) is not installed with the workflow package. Run `npm install`.");
    const web = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url);
    const serve: Handler = await web.createWorkflowWebHandler({ basename: BASE });
    // Its stylesheet loads the fonts from /assets/, outside the basename.
    return async (req: Request) => {
      const res = await serve(req);
      if (res.status !== 200 || !res.headers.get("content-type")?.includes("text/css")) return res;
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      return new Response((await res.text()).replaceAll("url(/assets/", `url(${BASE}/assets/`), { headers });
    };
  })().catch((error) => { handler = undefined; throw error; });
  return handler;
}

/** Strict CBOR for RPC bodies: definite maps (text keys, no repeats), arrays, text, numbers, booleans, null, undefined. Throws on the rest. */
function cbor(b: Uint8Array): unknown {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const take = (n: number) => { if (i + n > b.length) throw new Error("short"); return (i += n) - n; };
  const item = (): unknown => {
    const head = b[take(1)], major = head >> 5, info = head & 31;
    if (major === 7) {
      const simple: Record<number, unknown> = { 20: false, 21: true, 22: null, 23: undefined };
      if (info in simple) return simple[info];
      if (info === 26) return v.getFloat32(take(4));
      if (info === 27) return v.getFloat64(take(8));
      throw new Error("simple");
    }
    const n = info < 24 ? info : info === 24 ? v.getUint8(take(1)) : info === 25 ? v.getUint16(take(2))
      : info === 26 ? v.getUint32(take(4)) : info === 27 ? Number(v.getBigUint64(take(8))) : NaN;
    if (Number.isNaN(n) || (major > 1 && n > b.length)) throw new Error("length");
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 3) return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(take(n), i));
    if (major === 4) return Array.from({ length: n }, () => item());
    if (major === 5) {
      const o: Record<string, unknown> = {};
      for (let k = 0; k < n; k++) {
        const key = item();
        if (typeof key !== "string" || Object.hasOwn(o, key)) throw new Error("key");
        o[key] = item();
      }
      return o;
    }
    throw new Error("type");
  };
  const out = item();
  if (i !== b.length) throw new Error("trailing");
  return out;
}

/** `{ success: false, error }` in CBOR, as the inspector's RPC answers, so its page shows the message. */
function refusal(message: string): Response {
  const head = (major: number, n: number) => (n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255]);
  const enc = (x: unknown): number[] => {
    if (typeof x === "boolean") return [x ? 0xf5 : 0xf4];
    if (typeof x === "string") { const s = [...new TextEncoder().encode(x)]; return [...head(3, s.length), ...s]; }
    const e = Object.entries(x as object);
    return [...head(5, e.length), ...e.flatMap(([k, y]) => [...enc(k), ...enc(y)])];
  };
  return new Response(new Uint8Array(enc({ success: false, error: { message, layer: "server" } })),
    { status: 403, headers: { "content-type": "application/cbor", "cache-control": "no-store" } });
}

/**
 * Any method on /api/gtm/inspector/** → the inspector's response. Local only. `loopback` (127.0.0.1/localhost, same
 * site) may do anything; a GTM_ALLOWED_HOSTS caller only reads: its RPC body is decoded here and passed on as JSON
 * when it names a read, so the inspector acts on exactly what was checked.
 */
export async function inspector(req: Request, loopback: boolean): Promise<Response> {
  if (isHosted()) throw new HttpError(404, "The run inspector is local only; hosted runs are in Vercel's dashboard (Open in Vercel)");
  const serve = await load();
  if (loopback || req.method === "GET" || req.method === "HEAD") return serve(req);
  if (req.method !== "POST" || new URL(req.url).pathname !== `${BASE}/api/rpc`) return refusal(REFUSED);
  let body: { method?: unknown } | undefined;
  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    body = (req.headers.get("content-type") ?? "").includes("application/cbor") ? cbor(raw) as typeof body : JSON.parse(new TextDecoder().decode(raw));
  } catch {}
  if (typeof body?.method !== "string" || !READS.includes(body.method)) return refusal(REFUSED);
  return serve(new Request(req.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/cbor" }, body: JSON.stringify(body) }));
}
