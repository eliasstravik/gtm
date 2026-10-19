"use client";
import NextLink from "next/link.js";
import { useCallback, useEffect, useState } from "react";

/** next/link is CommonJS: under NodeNext its default import is typed as the module, but bundlers hand over the component. */
export const Link = NextLink as unknown as typeof NextLink.default;

/** Calls `/api/gtm/<path>`; throws the API's `{ error }` text (or the HTTP status) on failure. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/gtm/${path}`, { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok || body == null) throw new Error(body?.error ?? `${res.status} ${res.statusText}`.trim());
  return body as T;
}

type State<T> = { path?: string | null; data?: T; error?: string; at: number };

/**
 * Loads `/api/gtm/<path>` (nothing while path is null) and again on `reload()` or when `key` changes. The last data
 * stays shown while a refresh is in flight; `at` changes after every result.
 */
export function useApi<T>(path: string | null, key?: unknown) {
  const [tick, setTick] = useState(0);
  const [s, set] = useState<State<T>>({ at: 0 });
  useEffect(() => {
    if (path == null) return;
    const ctrl = new AbortController();
    api<T>(path, { signal: ctrl.signal }).then(
      (data) => set((p) => ({ path, data, at: p.at + 1 })),
      (e: Error) => ctrl.signal.aborted || set((p) => ({ path, data: p.path === path ? p.data : undefined, error: e.message, at: p.at + 1 })),
    );
    return () => ctrl.abort();
  }, [path, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const same = s.path === path;
  return { data: same ? s.data : undefined, error: same ? s.error : undefined, at: s.at, reload };
}

/** What a view shows before its data arrives: the error, or a loading line. */
export function Pending({ error }: { error?: string }) {
  return error ? <p className="gtm-banner gtm-error">{error}</p> : <p className="gtm-muted">Loading…</p>;
}
