import { Marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * null for URLs with a scheme other than http(s) or mailto (javascript:, data:, …). Browsers ignore control
 * characters and spaces inside a scheme, so they are stripped before the check; entities cannot form a scheme
 * because the result is escaped in full (`&` too) when written into the attribute.
 */
function safeUrl(url: string): string | null {
  const bare = url.replace(/[\u0000- \u007f]/g, "");
  return /^[a-z][a-z0-9+.-]*:/i.test(bare) && !/^(https?|mailto):/i.test(bare) ? null : url;
}

const attr = (name: string, v: string | null | undefined) => (v ? ` ${name}="${esc(v)}"` : "");

const marked = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML in a file is shown as text, never injected; a lone comment (`<!-- … -->`) is dropped.
    html: ({ text, block }) => (/^\s*<!--(?:(?!-->)[\s\S])*-->\s*$/.test(text) ? "" : block ? `<p>${esc(text)}</p>` : esc(text)),
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (url == null) return inner;
      const external = /^https?:/i.test(url) ? ' target="_blank" rel="noreferrer"' : "";
      return `<a${attr("href", url)}${attr("title", title)}${external}>${inner}</a>`;
    },
    image({ href, title, text }) {
      const url = safeUrl(href);
      return url == null || /^mailto:/i.test(url) ? esc(text) : `<img${attr("src", url)} alt="${esc(text)}"${attr("title", title)}>`;
    },
  },
});

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * GitHub-flavored Markdown, read-only: raw HTML as text, only http(s), mailto and relative links; front matter as YAML.
 * With `lead` (a skill's description, null for none) the front matter is dropped and `lead` shows under the first heading.
 */
export function Markdown({ source, lead }: { source: string; lead?: string | null }) {
  const parse = (md: string) => marked.parse(md, { async: false });
  const body = source.replace(FRONT, "").trimStart(), h1 = /^# .*(?:\r?\n|$)/.exec(body)?.[0] ?? "";
  const html = lead === undefined ? parse(source.replace(FRONT, "```yaml\n$1\n```\n"))
    : parse(h1) + (lead ? `<p class="lead">${esc(lead)}</p>` : "") + parse(body.slice(h1.length));
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
