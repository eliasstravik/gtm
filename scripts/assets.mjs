// Copies what tsc does not emit into dist/: the stylesheets next to the modules that import them.
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

for (const f of readdirSync("src", { recursive: true })) {
  if (String(f).endsWith(".css")) cpSync(join("src", f), join("dist", f));
}
