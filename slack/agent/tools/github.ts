import { defineGhTool, githubShellApproval, type GitHubLeaseRule } from "eve/extensions/git/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { requesterOnly } from "../lib/approval";
import { egress } from "../sandbox";

// This project's own repository, from Vercel's system variables. The GitHub App connector is a Vercel Connect
// connector named "github/gtm" with access to this repository (create it once; see the gtm docs, slack.md).
const owner = process.env.VERCEL_GIT_REPO_OWNER ?? "";
const repository = `${owner}/${process.env.VERCEL_GIT_REPO_SLUG ?? ""}`;
const CONNECTOR = "github/gtm";

/** Commands that only read: everything else, including every push, waits for the requester's approval. */
const READ_ONLY = /^\s*(gh\s+repo\s+(clone|view)|git\s+(fetch|pull|ls-remote))\s/u;
/**
 * Every `git push` is refused: Vercel (Pro, private repo) deploys only commits by team members or by a GitHub app, and
 * a commit made in the sandbox is neither. `gh-signed-commit` commits the staged change through GitHub's API as this
 * connector's app (verified, marked as a bot), straight onto main.
 */
const PUSH = /^\s*git\s+push(\s|$)/u;

type Firewall = SandboxSession & { setNetworkPolicy?(policy: { allow: Record<string, readonly GitHubLeaseRule[]> }): Promise<void> };

/** Adds the GitHub credential at the sandbox firewall for one command, then removes it; the token never enters the sandbox. */
async function broker(sandbox: Firewall, rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null) {
  if (!sandbox.setNetworkPolicy) throw new Error("GitHub access needs a Vercel Sandbox: it works on the deployed agent only.");
  await sandbox.setNetworkPolicy({ allow: { ...egress, ...rules } });
}

const gh = defineGhTool(
  () => ({ connector: CONNECTOR, org: owner, broker, authorize: (r) => r.repository.toLowerCase() === repository.toLowerCase() }),
  `Run one authenticated GitHub command for this project's repository, ${repository}: \`gh repo clone ${repository}\`, \`git pull origin main\`, \`gh-signed-commit --repo ${repository} --branch main -m "<headline>"\` (commits the staged change to main) and other gh commands. Declare that repository in permissions (access "write"). Clone, view, fetch, pull and ls-remote run at once; anything else, every commit included, first asks the person who asked you to approve it, so say in \`description\` what changes and why. \`git push\` is refused. Argv syntax only, no pipes or substitutions. Use bash for local git status, diff and add.`,
);

/** The only way this agent writes to GitHub: stage with bash, then gh-signed-commit to main here after the yes. */
export default defineTool({
  ...gh,
  approval: {
    request: ({ toolInput }) => {
      const checked = githubShellApproval(toolInput);
      if (checked !== "not-applicable") return checked;
      if (PUSH.test(toolInput?.command ?? "")) {
        return { type: "denied", reason: `git push is refused; stage the change, then run gh-signed-commit --repo ${repository} --branch main -m "<headline>".` };
      }
      return READ_ONLY.test(toolInput?.command ?? "") ? "not-applicable" : "user-approval";
    },
    response: requesterOnly,
    prompt: ({ input }) => `${input.description}\n\`${input.command}\``,
  },
  label: { start: ({ command }) => (READ_ONLY.test(command) ? "Read from GitHub" : "Write to GitHub") },
});
