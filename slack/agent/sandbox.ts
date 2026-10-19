import { installCodeTooling } from "eve/extensions/code/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/** The only hosts the sandbox can reach: GitHub (checkout and push) and the npm registry (npm install). */
export const HOSTS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org"];
export const egress = Object.fromEntries(HOSTS.map((host) => [host, []]));

/**
 * Where the agent checks out and edits this repo: a Vercel Sandbox (its firewall carries the GitHub credential, see
 * tools/github.ts). It never sees the app's environment variables: no GTM_VERCEL_TOKEN, no keys.
 */
export const environment = VercelSandbox.environment({
  async prepare(sandbox) {
    await installCodeTooling(sandbox);
    await sandbox.run({ command: "git config --global user.name 'GTM Slack agent' && git config --global user.email 'gtm-agent@users.noreply.github.com'" });
  },
});

export default defineSandbox(() => environment.open({ networkPolicy: { allow: egress } }));
