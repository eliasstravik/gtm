#!/usr/bin/env node
import { join } from "node:path";
import { packageRoot, readJson } from "./cli/project.js";

type Command = (args: string[]) => Promise<void>;

const USAGE = `gtm: a company's go-to-market work as an ordinary Next.js project (npx @eliasstravik/gtm <command>)

  init [dir] [--slack]      create a project in an empty folder, or repair one (missing wiring, AGENTS.md block)
  dev                       run the Console and workflows on 127.0.0.1:$GTM_PORT (default 3000)
  migrate                   apply database migrations (the package's, then db/migrations)
  check [--prod]            report problems with their fixes; print the local DATABASE_URL
  run <workflow> [--input <json>] [--prod] [--no-wait]
                            start a run and print its status, return value and error
  docs [topic]              print the docs of this version`;

// Loaded on demand so `gtm docs` never loads the database stack.
const commands: Record<string, () => Promise<Command>> = {
  init: async () => (await import("./cli/init.js")).init,
  dev: async () => (await import("./cli/dev.js")).dev,
  migrate: async () => (await import("./cli/migrate.js")).migrateCommand,
  check: async () => (await import("./cli/check.js")).check,
  run: async () => (await import("./cli/run.js")).run,
  docs: async () => (await import("./cli/docs.js")).docs,
};

const [name, ...args] = process.argv.slice(2);
if (name === "--version" || name === "-v") console.log(readJson(join(packageRoot(), "package.json"))?.version);
else if (!name || !commands[name] || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  if (name && !commands[name] && !["help", "--help", "-h"].includes(name)) process.exitCode = 1;
} else {
  try {
    await (await commands[name]())(args);
  } catch (error) {
    console.error(`gtm ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
