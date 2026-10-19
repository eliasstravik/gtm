"use client";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "./style.css";
import { usePathname } from "next/navigation.js";
import { useEffect, useRef, type ReactNode } from "react";
import { EnvironmentBadge } from "./environment.js";
import { Link, Status, useApi } from "./load.js";

type Info = { company: string; environment: "local" | "preview" | "production"; database: string | null; deployment: string | null; connectionsMissing: number };

/** Each section with the paths that mark it current; Runs is listed under Workflows. */
const NAV: [label: string, href: string, current: RegExp, sub?: true][] = [
  ["Context", "/context", /^\/(context(\/|$)|$)/], ["Workflows", "/workflows", /^\/workflows(\/|$)/], ["Runs", "/runs", /^\/runs$/, true],
  ["Data", "/data", /^\/data$/], ["Connections", "/connections", /^\/connections$/],
];
/** Views whose table scrolls under a fixed title and toolbar on desktop. */
const FILL = /^\/(runs|data|workflows\/[^/]+)$/;

/**
 * The Console's frame: a sidebar with the company, the environment and the sections; below 1024px a top bar whose
 * menu button opens the same sections in a modal <dialog>. The button leads, on the side the panel slides in from.
 */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const shell = useApi<Info>("shell", () => 30_000), { data: info, reload } = shell;
  const menu = useRef<HTMLDialogElement>(null), seen = useRef(pathname), deployment = useRef<string | null>(null);
  const current = NAV.find(([, , re]) => re.test(pathname));
  // Read again on navigation, so a key added on Connections clears the count when you leave.
  useEffect(() => {
    menu.current?.close();
    if (seen.current !== pathname) reload();
    seen.current = pathname;
  }, [pathname, reload]);
  // The tab says where you are ("Data · Stråvik"); the html element carries the environment for the local top rule.
  useEffect(() => {
    if (!info) return;
    const workflow = pathname.match(/^\/workflows\/([^/]+)$/)?.[1];
    const view = workflow ? decodeURIComponent(workflow) : current?.[0];
    document.title = view ? `${view} · ${info.company}` : info.company;
    document.documentElement.dataset.environment = info.environment;
  }, [pathname, current, info]);
  // A new deployment brings new page code: reload for it, but never under an open dialog or menu (the next read retries).
  useEffect(() => {
    const next = info?.deployment;
    if (!next || next === deployment.current) return;
    if (!deployment.current) deployment.current = next;
    else if (!document.querySelector("dialog[open], [popover]:popover-open")) location.reload();
  }, [info]);
  const missing = info?.connectionsMissing ?? 0;
  const brand = (
    <div className="brand">
      <Link href="/" className="company">{info?.company ?? " "}</Link>
      <EnvironmentBadge environment={info?.environment} />
    </div>
  );
  const nav = (
    <nav className="nav" aria-label="Console">
      <ul role="list">
        {NAV.map(([label, href, , sub]) => (
          <li key={href} className={sub && "sub"}>
            <Link href={href} aria-current={current?.[1] === href ? "page" : undefined}>
              {label}
              {href === "/connections" && missing > 0 && <span className="nav-count" title={`${missing} not set here`}>
                <span className="sr-only">, </span>{missing}<span className="sr-only"> not set</span></span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
  const button = (label: string, d: string, onClick: () => void) => (
    <button type="button" className="icon" aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
  );
  const open = () => { menu.current?.showModal(); menu.current?.querySelector<HTMLElement>(".icon")?.focus(); };
  const close = () => menu.current?.close();
  return (
    <div className="app">
      <aside className="sidebar">{brand}{nav}</aside>
      <header className="topbar">{button("Open menu", "M3 6h14M3 10h14M3 14h14", open)}{brand}</header>
      {/* Clicks on the backdrop land on the dialog itself; the panel inside it catches the rest. */}
      <dialog ref={menu} className="drawer" aria-label="Menu" onClick={(e) => (e.target === e.currentTarget || (e.target as Element).closest("a")) && close()}>
        <div className="drawer-panel">
          <div className="drawer-top">{button("Close menu", "M5 5l10 10M15 5L5 15", close)}{brand}</div>
          {nav}
        </div>
      </dialog>
      <main className={FILL.test(pathname) ? "main fill" : "main"}>
        <Status state={{ ...shell, loading: false }} />
        {children}
      </main>
    </div>
  );
}
