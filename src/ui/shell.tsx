"use client";
import { usePathname } from "next/navigation.js";
import type { ReactNode } from "react";
import { Link, useApi } from "./load.js";

type Info = { company: string; environment: "local" | "preview" | "production"; database: string | null; pages: string[] };

const VIEWS = ["context", "workflows", "data", "connections"];
const label = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[-_]+/g, " ");

/** The cockpit layout: company name, environment and database badge, the menu (four views, then agent pages) and the page. */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Fetched again on every navigation, so a new app/<slug>/page.tsx shows under Pages without restarting `gtm dev`.
  const { data: info, error } = useApi<Info>("shell", pathname);
  const item = (slug: string, page = false) => {
    const on = pathname === `/${slug}` || pathname.startsWith(`/${slug}/`) || (slug === "context" && pathname === "/");
    return (
      <Link key={slug} href={`/${slug}`} className={page ? "gtm-tab gtm-page" : "gtm-tab"} aria-current={on ? "page" : undefined}>
        {label(slug)}
      </Link>
    );
  };
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="gtm-bar">
        <Link href="/" className="gtm-logo">{info?.company ?? " "}</Link>
        {info && (
          <span className={`gtm-env gtm-${info.environment}`} title="Environment · database">
            {label(info.environment)}{info.database ? ` · ${info.database}` : ""}
          </span>
        )}
      </header>
      <nav className="gtm-tabs">
        {VIEWS.map((v) => item(v))}
        {!!info?.pages.length && (
          <>
            <span className="gtm-sep" />
            <span className="gtm-label">Pages</span>
            {info.pages.map((p) => item(p, true))}
          </>
        )}
      </nav>
      <main className="gtm-main">
        {error && <p className="gtm-banner gtm-error">{error}</p>}
        {children}
      </main>
    </>
  );
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--sub:#525252;--muted:#737373;--line:rgb(10 10 10/.08);--line2:rgb(10 10 10/.14);--fill:#f5f5f5;--accent:#c2410c;--accentfill:rgb(194 65 12/.09);--good:#15803d;--bad:#b91c1c;--warn:#a16207}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--sub:#d4d4d4;--muted:#a3a3a3;--line:rgb(255 255 255/.09);--line2:rgb(255 255 255/.16);--fill:#1c1c1c;--accent:#fb923c;--accentfill:rgb(251 146 60/.12);--good:#4ade80;--bad:#f87171;--warn:#facc15}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
@media(min-width:640px){body{font-size:14px}}
a{color:inherit}button,input{font:inherit;color:inherit}:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
code,pre,.gtm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
h2.gtm-h{font-size:15px;font-weight:600;margin:0 0 8px}
.gtm-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.gtm-logo{font-weight:700;letter-spacing:-.01em;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gtm-env{margin-left:auto;font-size:12px;font-weight:600;padding:2px 10px;border-radius:99px;background:var(--fill);color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:65vw}
.gtm-env::before,.gtm-status::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);margin-right:6px;vertical-align:1px}
.gtm-local::before,.gtm-s-completed::before{background:var(--good)}.gtm-preview::before{background:var(--warn)}
.gtm-production::before,.gtm-s-running::before,.gtm-s-pending::before{background:var(--accent)}.gtm-s-failed::before{background:var(--bad)}
.gtm-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:8px 16px;border-bottom:1px solid var(--line)}
.gtm-tab{padding:3px 10px;border-radius:8px;color:var(--sub);font-weight:500;text-decoration:none}
.gtm-tab:hover,.gtm-side a:hover{background:var(--fill)}.gtm-tab[aria-current]{background:var(--fill);color:var(--fg);font-weight:600}
.gtm-page{color:var(--accent)}.gtm-page::before{content:"✦ ";font-size:11px}
.gtm-sep{width:1px;height:18px;background:var(--line2);margin:0 4px}
.gtm-label,.gtm-side h4{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.gtm-main{padding:20px 16px 48px}
.gtm-muted{color:var(--muted)}.gtm-error{color:var(--bad)}.gtm-ok{color:var(--good)}
.gtm-banner{padding:8px 12px;border-radius:8px;background:var(--fill);margin:0 0 16px}.gtm-warn{color:var(--warn)}
.gtm-cols{display:grid;grid-template-columns:minmax(160px,250px) minmax(0,1fr);gap:28px;align-items:start}
@media(max-width:720px){.gtm-cols{grid-template-columns:minmax(0,1fr);gap:16px}}
.gtm-side{display:flex;flex-direction:column;font-size:13px;min-width:0}.gtm-side h4{margin:14px 0 4px 8px}.gtm-side h4:first-child{margin-top:0}
.gtm-side a,.gtm-dir{display:flex;gap:8px;justify-content:space-between;padding:2px 8px;border-radius:6px;text-decoration:none;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gtm-side a[aria-current]{background:var(--accentfill);color:var(--fg)}.gtm-dir{color:var(--muted)}
.gtm-doc{min-width:0;max-width:74ch}.gtm-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin:0 0 12px;color:var(--muted);font-size:13px}
.gtm-head>span{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.gtm-head h2{margin:0;color:var(--fg)}
.gtm-btn{display:inline-block;padding:3px 12px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--fg);text-decoration:none;cursor:pointer}
.gtm-btn[aria-disabled],.gtm-btn:disabled{opacity:.4;pointer-events:none}
section+section{margin-top:28px}
.gtm-table{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.gtm-table table{border-collapse:collapse;width:100%;font-size:13px}
.gtm-table th,.gtm-table td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:30em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.gtm-table th{font-weight:600;color:var(--sub);background:var(--fill)}.gtm-table tr:last-child td{border-bottom:0}
.gtm-list{border:1px solid var(--line);border-radius:10px}
.gtm-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 14px;border-bottom:1px solid var(--line)}.gtm-row:last-child{border-bottom:0}
.gtm-row>div{flex:1 1 260px;min-width:0}.gtm-row form{flex:0 1 360px;display:flex;gap:8px}
.gtm-row input{flex:1;min-width:0;padding:4px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--bg)}
.gtm-badge{font-size:12px;font-weight:600;padding:1px 8px;margin-left:8px;border-radius:99px;background:var(--fill)}
.gtm-md{max-width:74ch;line-height:1.7;overflow-wrap:anywhere}.gtm-md>:first-child{margin-top:0}.gtm-md a{color:var(--accent)}.gtm-md img{max-width:100%}
.gtm-md h1{font-size:1.6em;line-height:1.25;letter-spacing:-.02em;margin:0 0 .6em}.gtm-md h2{font-size:1.25em;margin:1.6em 0 .5em}.gtm-md h3{font-size:1.05em;margin:1.4em 0 .4em}
.gtm-md :is(p,ul,ol,pre,blockquote,table){margin:0 0 1em}.gtm-md :is(ul,ol){padding-left:1.4em}.gtm-md hr{border:0;border-top:1px solid var(--line2);margin:2em 0}
.gtm-md code{background:var(--fill);padding:.1em .35em;border-radius:4px}.gtm-md pre{background:var(--fill);padding:10px 12px;border-radius:8px;overflow-x:auto}.gtm-md pre code{padding:0}
.gtm-md blockquote{padding-left:12px;margin-left:0;border-left:3px solid var(--line2);color:var(--sub)}.gtm-md table{border-collapse:collapse;display:block;overflow-x:auto}.gtm-md :is(th,td){border:1px solid var(--line2);padding:4px 10px}
`;
