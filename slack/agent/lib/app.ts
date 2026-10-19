/**
 * Calls this project's own gtm API (`/api/gtm/*`), the same routes `gtm run --prod` uses. Hosted: the production
 * domain (a preview deployment calls itself, never production), past Vercel Authentication with the Protection
 * Bypass for Automation secret that `start` and `runs` require. Locally: `npm run dev` on 127.0.0.1:$GTM_PORT.
 * Failures throw a message the model can read.
 */
export async function gtmApi(path: string, init: RequestInit = {}): Promise<unknown> {
  const hosted = Boolean(process.env.VERCEL_DEPLOYMENT_ID) && /^(preview|production)$/.test(process.env.VERCEL_ENV ?? "");
  const headers = new Headers(init.headers);
  let base = `http://127.0.0.1:${process.env.GTM_PORT || 3000}`;
  if (hosted) {
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const domain = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
    if (!bypass || !domain) throw new Error("Turn on Protection Bypass for Automation and system environment variables in the Vercel project, then redeploy.");
    headers.set("x-vercel-protection-bypass", bypass);
    base = `https://${domain}`;
  }
  const response = await fetch(`${base}/api/gtm${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(`gtm API ${path} answered ${response.status}: ${body?.error ?? "no details"}`);
  return body;
}
