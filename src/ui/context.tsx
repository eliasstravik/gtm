"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation.js";
import type { MouseEvent } from "react";
import { Link, Pending, useApi } from "./load.js";
import { Markdown } from "./markdown.js";

type Listing = { groups: { name: string; files: { path: string; title: string }[] }[] };
type Doc = { path: string; markdown: string; githubUrl: string | null };
type Item = { key: string; label: string; depth: number; file?: { path: string; title: string } };

/** Tree rows: each folder once, files indented under it (paths arrive sorted). Skills are labelled by their folder. */
function tree(group: Listing["groups"][number]): Item[] {
  const out: Item[] = [];
  let prev: string[] = [];
  for (const file of group.files) {
    const parts = file.path.split("/");
    if (group.name === "Skills") {
      out.push({ key: file.path, label: parts.at(-2) ?? file.path, depth: 0, file });
      continue;
    }
    const dirs = parts.slice(0, -1);
    let i = 0;
    while (i < dirs.length && dirs[i] === prev[i]) i += 1;
    for (; i < dirs.length; i += 1) out.push({ key: `${dirs.slice(0, i + 1).join("/")}/`, label: `${dirs[i]}/`, depth: i });
    out.push({ key: file.path, label: parts.at(-1)!, depth: dirs.length, file });
    prev = dirs;
  }
  return out;
}

/** Context: the company's context files and skills; the selected one (`?file=`) rendered read-only. */
export function ContextView() {
  const pathname = usePathname();
  const list = useApi<Listing>("context");
  const groups = list.data?.groups ?? [];
  const path = useSearchParams().get("file") ?? groups.find((g) => g.files.length)?.files[0].path ?? null;
  const doc = useApi<Doc>(path && `context/file?path=${encodeURIComponent(path)}`);
  const router = useRouter();
  // A relative link to another listed file (e.g. `icps/enterprise.md`) opens it here instead of leaving the cockpit.
  const follow = (e: MouseEvent) => {
    const href = (e.target as Element).closest("a")?.getAttribute("href");
    if (!href || !path || e.metaKey || e.ctrlKey || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return;
    const target = decodeURIComponent(new URL(href, `http://x/${path}`).pathname.slice(1));
    if (!groups.some((g) => g.files.some((f) => f.path === target))) return;
    e.preventDefault();
    router.push(`${pathname}?file=${encodeURIComponent(target)}`);
  };
  if (!list.data) return <Pending error={list.error} />;
  return (
    <div className="gtm-cols">
      <nav className="gtm-side">
        {groups.map((g) => (
          <div key={g.name}>
            <h4>{g.name}</h4>
            {g.files.length === 0 && <span className="gtm-dir">None yet</span>}
            {tree(g).map((it) => {
              const style = { paddingLeft: 8 + it.depth * 14 };
              if (!it.file) return <span key={it.key} className="gtm-dir gtm-mono" style={style}>{it.label}</span>;
              return (
                <Link key={it.key} href={`${pathname}?file=${encodeURIComponent(it.file.path)}`} title={it.file.title}
                  className="gtm-mono" style={style} aria-current={it.file.path === path ? "page" : undefined}>
                  {it.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <article className="gtm-doc" onClick={follow}>
        {!path ? (
          <p className="gtm-muted">No context yet. Your agent writes it as Markdown files under context/.</p>
        ) : !doc.data ? (
          <Pending error={doc.error} />
        ) : (
          <>
            <div className="gtm-head">
              <span className="gtm-mono">{doc.data.path}</span>
              {doc.data.githubUrl && <a href={doc.data.githubUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}
            </div>
            <Markdown source={doc.data.markdown} />
          </>
        )}
      </article>
    </div>
  );
}
