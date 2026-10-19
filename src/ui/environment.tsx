"use client";
import { useEffect, useState } from "react";
import { api } from "./load.js";

type Release = { state: "updating" | "live" | "failed"; details?: string };
/** The redeploy a hosted save last started, `{ id, at }`, kept in localStorage so every tab follows it, for 15 minutes at most. */
const KEY = "gtm-console-release", SETTLED = "gtm-console-release-settled";
const names: Record<string, string> = { local: "Local", preview: "Preview", production: "Production" };
const following = (): string | null => {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? "null"); return typeof s?.id === "string" && Date.now() - s.at < 15 * 60_000 ? s.id : null; } catch { return null; }
};

/** Called when a hosted save starts a redeploy (`id`, its deployment): every tab's badge turns amber at once. */
export function releaseStarted(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* This tab still shows it. */ }
  dispatchEvent(new Event(KEY));
}
/** Calls `fn` when the followed redeploy is live or failed, so a view reads again what it changed; returns the unsubscribe. */
export const onReleaseSettled = (fn: () => void) => (addEventListener(SETTLED, fn), () => removeEventListener(SETTLED, fn));

/**
 * The followed redeploy's state, one poller for every badge on the page (the sidebar's and the top bar's): read every
 * 5 s while it builds, "live" shown for 8 s. `settled` is the id this page has an outcome for (a reload asks once more).
 */
const badges = new Set<(r: Release | null) => void>();
let release: Release | null = null, timer: ReturnType<typeof setTimeout> | undefined, fade: typeof timer, settled = "";
const show = (r: Release | null) => { release = r; badges.forEach((set) => set(r)); };
async function check() {
  clearTimeout(timer);
  const id = following();
  if (!badges.size || !id || id === settled) return release?.state === "updating" && show(null);
  show({ state: "updating" });
  const next = await api<{ release: Release | null }>(`release?id=${encodeURIComponent(id)}`).then((r) => r.release, () => undefined);
  if (following() !== id) return;
  if (next === undefined || next?.state === "updating") return void (timer = setTimeout(check, 5000));
  settled = id; clearTimeout(fade); show(next); dispatchEvent(new Event(SETTLED));
  if (next?.state === "live") fade = setTimeout(() => show(null), 8000);
}
if (typeof window !== "undefined") { addEventListener(KEY, check); addEventListener("storage", (e) => e.key === KEY && check()); }
function useRelease(on: boolean): Release | null {
  const [state, setState] = useState(release);
  useEffect(() => {
    if (!on) return;
    badges.add(setState);
    if (badges.size === 1) check(); else setState(release);
    return () => void badges.delete(setState);
  }, [on]);
  return on ? state : null;
}

/** Local, Preview or Production at the top of the sidebar; Production also says whether a saved key is live yet. */
export function EnvironmentBadge({ environment }: { environment?: string }) {
  const release = useRelease(environment === "production"), state = release?.state;
  if (!environment) return null;
  const kind = names[environment] ? environment : "preview", name = names[kind];
  return (
    <span className="environment-badge" data-environment={kind} data-state={state} role="status"
      title={state === "updating" ? "Production: your change goes live in about a minute" : kind === "local" ? "The Console on this computer" : `Hosted on Vercel (${name})`}>
      {state ? <span><span className="badge-name">{name} · </span>{state === "updating" ? "Updating…" : state === "live" ? "Your change is live" : "Update failed"}</span> : name}
      {state === "updating" && <span className="badge-more">live in about a minute</span>}
      {release?.details && <a href={release.details} target="_blank" rel="noreferrer">Details</a>}
    </span>
  );
}
