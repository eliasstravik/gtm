/** Company skills are `.agents/skills/<folder>/SKILL.md`. No imports: the Console, the API and agent() share it. */
export const SKILLS_DIR = ".agents/skills";

/** A skill folder name: letters, digits, `.`, `_` and `-`, not starting with a dot (so no `..` or `/`). */
export const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * A SKILL.md's front matter `name` and `description` (plain, quoted, multi-line or `>`/`|` block scalars) and the
 * body after it. Without front matter the whole file is the body.
 */
export function parseSkill(markdown: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m) return { body: markdown };
  const fields: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const head = (kv[2] ?? "").trim(), more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (!lines[i + 1].trim() && /^\s+\S/.test(lines[i + 2] ?? "")))) more.push(lines[++i].trim());
    const block = /^[>|][+-]?$/.test(head);
    let v = block && head.startsWith("|") ? more.join("\n") : [block ? "" : head, ...more].join(" ").replace(/\s+/g, " ");
    v = v.trim();
    const q = /^(["'])([\s\S]*)\1$/.exec(v);
    if (q) v = q[1] === "'" ? q[2].replaceAll("''", "'") : q[2].replace(/\\(["\\])/g, "$1");
    fields[kv[1]] = v;
  }
  return { name: fields.name || undefined, description: fields.description || undefined, body: markdown.slice(m[0].length) };
}
