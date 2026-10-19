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
    // Raw HTML in a file is shown as text, never injected; a lone comment (e.g. the AGENTS.md block markers) is dropped.
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

/** GitHub-flavored Markdown, read-only: raw HTML as text, only http(s), mailto and relative links; front matter as YAML. */
export function Markdown({ source }: { source: string }) {
  const md = source.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/, "```yaml\n$1\n```\n");
  return <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(md, { async: false }) }} />;
}
