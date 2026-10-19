"use client";

/** Local, Preview or Production, and whether a saved key is live yet. (Stub until the Connections helper fills it in.) */
export function EnvironmentBadge({ environment }: { environment?: string }) {
  return environment ? <span className="environment-badge" data-environment={environment}>{environment}</span> : null;
}
