"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Heroicons 16 solid: arrow-path, ellipsis-horizontal. */
export const glyphs = {
  refresh: "M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z",
  more: "M2 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM12.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
};
export const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 16 16" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={d} /></svg>;

/**
 * Places a fixed popover under its trigger, or above it when there is no room below; always inside the window.
 * `end` lines up the right edges, for a trigger at the end of a row.
 */
export function place(trigger: HTMLElement, panel: HTMLElement, width: number, end = false) {
  const rect = trigger.getBoundingClientRect(), height = panel.offsetHeight || Math.min(420, innerHeight - 24);
  const top = rect.bottom + height + 6 <= innerHeight - 12 ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
  panel.style.setProperty("--popover-left", `${Math.max(12, Math.min(end ? rect.right - width : rect.left, innerWidth - width - 12))}px`);
  panel.style.setProperty("--popover-top", `${top}px`);
}

/**
 * A button and its menu of actions, in the top layer: Escape, a click outside or picking an item closes it, and the
 * arrow keys move between items. Items are `role="menuitem"` buttons or links.
 */
export function Menu({ label, className, trigger, children }: { label: string; className?: string; trigger: ReactNode; children: ReactNode }) {
  const id = useId(), button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  const position = () => button.current && panel.current && place(button.current, panel.current, panel.current.offsetWidth || 200, true);
  function onKey(e: KeyboardEvent) {
    const all = items(), at = all.indexOf(document.activeElement as HTMLElement);
    const to = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined || !all.length) return;
    e.preventDefault();
    all[(to + all.length) % all.length].focus();
  }
  return (
    <>
      <button type="button" ref={button} className={className} aria-label={label} title={typeof trigger === "string" ? undefined : label} aria-haspopup="menu" popoverTarget={id}>{trigger}</button>
      <div id={id} ref={panel} popover="auto" role="menu" aria-label={label} className="menu" onKeyDown={onKey}
        // Placed before showing (no flash at the corner), then again with its real size.
        onBeforeToggle={(e) => e.newState === "open" && position()}
        onToggle={(e) => { if (e.newState === "open") { position(); items()[0]?.focus(); } }}
        onClick={(e) => (e.target as Element).closest('[role="menuitem"]') && panel.current?.hidePopover()}>
        {children}
      </div>
    </>
  );
}
