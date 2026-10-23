#!/usr/bin/env node
/**
 * `npm run check:names [files…] [--tarball <file.tgz>] [--messages <git range>]`: fails when public copy names a term
 * from GTM_RIVAL_NAMES (comma- or newline-separated; the list itself never enters the repo). Whole words, any case;
 * each hit prints as file:line with the term masked. With no files it reads every tracked file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tarball: { type: "string" }, messages: { type: "string" } } });
const terms = (process.env.GTM_RIVAL_NAMES ?? "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
if (!terms.length) {
  console.error("check:names: GTM_RIVAL_NAMES is not set, so there is nothing to check against. Set it (a CI secret) and run again.");
  process.exit(1);
}
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map(escape).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
const mask = (t) => `${t[0]}${"*".repeat(Math.max(1, t.length - 1))}`;
let hits = 0;

function scan(label, text) {
  if (text.includes("\0")) return; // binary
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(pattern)) { hits += 1; console.log(`${label}:${i + 1}: ${mask(m[1])}`); }
  });
}
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

const files = positionals.length || values.tarball || values.messages ? positionals
  : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const f of files) { try { scan(f, readFileSync(f, "utf8")); } catch {} }
if (values.tarball) {
  const dir = mkdtempSync(join(tmpdir(), "check-names-"));
  try {
    execFileSync("tar", ["-xzf", values.tarball, "-C", dir]);
    for (const f of walk(dir)) scan(`${values.tarball}:${relative(dir, f)}`, readFileSync(f, "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (values.messages) {
  const log = execFileSync("git", ["log", "--format=%H%n%B%x00", values.messages], { encoding: "utf8" });
  for (const entry of log.split("\0").map((e) => e.trim()).filter(Boolean)) {
    const [sha, ...body] = entry.split("\n");
    scan(`commit ${sha.slice(0, 12)}`, body.join("\n"));
  }
}
if (hits) {
  console.error(`check:names: ${hits} mention(s) of a listed name. Public copy names no alternative or competing product.`);
  process.exit(1);
}
console.log("check:names: no listed names.");
