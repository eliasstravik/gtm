/** An error the router answers as `{ error }` with this HTTP status. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** JSON with JSON-safe values: Date → ISO (its toJSON), bigint → string, bytes → `\x` hex. */
export function toJson(body: unknown): string {
  return JSON.stringify(body, function (this: Record<string, unknown>, key, v: unknown) {
    const raw = this[key];
    if (raw instanceof Uint8Array) return `\\x${Buffer.from(raw).toString("hex")}`;
    return typeof v === "bigint" ? v.toString() : v;
  });
}

/** A JSON response that is never cached. */
export function json(body: unknown, status = 200): Response {
  return new Response(toJson(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
