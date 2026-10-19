/**
 * Links into Vercel's dashboard for this deployment's project. Deployments know neither the team slug nor the project
 * name, so with GTM_VERCEL_TOKEN they are looked up once per instance; without it Vercel's own deep link asks for them.
 */
import { environment, isHosted, value } from "../shared/env.js";

const API = "https://api.vercel.com";

/** A Vercel REST call with `token`; throws `Error` with the status and Vercel's error code, never the body. */
export async function vercelApi<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
  const res = await fetch(`${API}${path}`, {
    method, body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error("Could not reach the Vercel API."); });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!res.ok) throw new Error(`The Vercel API refused ${method} ${path.split("?")[0]} (${res.status}${data.error?.code ? ` ${data.error.code}` : ""}).`);
  return data;
}

type Project = { team: string; teamId: string; project: string };
let cached: Promise<Project | null> | undefined;

/** The team slug and project name, hosted with GTM_VERCEL_TOKEN; null otherwise or when the lookup fails (retried next time). */
export function vercelProject(): Promise<Project | null> {
  const token = value("GTM_VERCEL_TOKEN"), id = value("VERCEL_PROJECT_ID"), deployment = value("VERCEL_DEPLOYMENT_ID");
  if (!isHosted() || !token || !id || !deployment) return Promise.resolve(null);
  cached ??= (async () => {
    const p = await vercelApi<{ name: string; accountId: string }>(token, `/v9/projects/${encodeURIComponent(id)}`);
    // A project-scoped token may not read the team, but this deployment's inspector link names both: /<team>/<project>/<id>.
    const d = await vercelApi<{ inspectorUrl?: string }>(token, `/v13/deployments/${encodeURIComponent(deployment)}?teamId=${encodeURIComponent(p.accountId)}`);
    const [team] = d.inspectorUrl?.startsWith("https://vercel.com/") ? new URL(d.inspectorUrl).pathname.split("/").filter(Boolean) : [];
    if (!team) throw new Error("The deployment has no inspector link to read the team from.");
    return { team: decodeURIComponent(team), teamId: p.accountId, project: p.name };
  })().catch((error) => {
    console.error("[gtm] could not look up the Vercel team and project", error);
    cached = undefined;
    return null;
  });
  return cached;
}

/**
 * A dashboard page of this project, `path` after `/<team>/<project>` (e.g. `/workflows/runs/<id>`, `/stores`): direct
 * when the team and project are known, else Vercel's `/d` link, which asks for them. Null when not hosted.
 */
export async function dashboardUrl(path: string, title: string, query = ""): Promise<string | null> {
  if (!isHosted()) return null;
  const p = await vercelProject(), q = query ? `?${query}` : "";
  if (p) return `https://vercel.com/${encodeURIComponent(p.team)}/${encodeURIComponent(p.project)}${path}${q}`;
  return `https://vercel.com/d?to=${encodeURIComponent(`/[team]/[project]${path}${q}`)}&title=${encodeURIComponent(title)}`;
}

/** The Workflows page of the dashboard for this environment: all runs, or one run. */
export const runsUrl = (runId?: string) =>
  dashboardUrl(runId ? `/workflows/runs/${encodeURIComponent(runId)}` : "/workflows", runId ? "Workflow run" : "Workflow runs", `environment=${environment()}`);
