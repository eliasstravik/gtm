import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, readJson } from "./project.js";

/** `gtm docs [topic]`: prints one doc of the installed version, or lists the topics. */
export async function docs(args: string[]): Promise<void> {
  const dir = join(packageRoot(), "docs");
  const topics = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [];
  const topic = args[0]?.replace(/\.md$/, "");
  if (topic && topics.includes(topic)) return void process.stdout.write(readFileSync(join(dir, `${topic}.md`), "utf8"));
  if (topic) {
    console.error(`No doc "${topic}".`);
    process.exitCode = 1;
  }
  const version = readJson(join(packageRoot(), "package.json"))?.version;
  console.log(`Docs for @eliasstravik/gtm ${version} (also in node_modules/@eliasstravik/gtm/docs/):`);
  for (const t of topics) console.log(`  npx @eliasstravik/gtm docs ${t}`);
}
