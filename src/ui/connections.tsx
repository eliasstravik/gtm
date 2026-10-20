"use client";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { onReleaseSettled, releaseStarted } from "./environment.js";
import { api, Link, Status, useApi } from "./load.js";
import { glyphs, Icon } from "./menu.js";
import "./connections.css";

type State = "set" | "missing" | "saved" | "provided" | "readonly";
type Connection = { name: string; description: string; set: boolean; state: State; usedBy: string[]; actions: ("save" | "rename" | "delete")[];
  shell?: boolean; reserved?: boolean };
type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; settingsUrl?: string; csrf?: string };
type Data = { connections: Connection[]; environment: string; save: Save; tokenWarning: string | null; listError: string | null;
  settingsUrl: string | null; usageComplete: boolean };
type Done = { ok: true; status: string; id?: string; redeploy?: "started" | "skipped" | "failed"; shell?: boolean };
type Open = { kind: "add" | "edit" | "delete"; c?: Connection };
/** Heroicons 16 solid: check-circle, x-circle, clock, lock-closed, and the shared refresh and more. */
const icons = {
  set: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z",
  missing: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z",
  saved: "M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z",
  readonly: "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
  ...glyphs,
};
const labelOf = (c: Connection) => c.description || c.name;
/** Up to three workflow links (to each one's Connections tab), then "and N more". */
const workflowLinks = (ids: string[]) => <>{ids.slice(0, 3).map((id, i) => <Fragment key={id}>{i ? ", " : ""}
  <Link href={`/workflows/${encodeURIComponent(id)}?view=connections`}>{id}</Link></Fragment>)}{ids.length > 3 ? ` and ${ids.length - 3} more` : ""}</>;
const post = (body: object, csrf?: string) => api<Done>("connections", { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(csrf && { "x-gtm-csrf": csrf }) } });

/**
 * Connections: every key by its label, whether it is set here (never its value) and the workflows using it. Add, Edit
 * and Delete write locally to .env.local and .env.example, hosted to Vercel's Production env, which then redeploys.
 */
export function ConnectionsView({ only }: { only?: string[] | null }) {
  // Hosted keys saved from this page read "going live" until the redeploy is.
  const [saved, setSaved] = useState<string[]>([]), [note, setNote] = useState(""), [retry, setRetry] = useState(""), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | null>(null), [menu, setMenu] = useState(""), trigger = useRef<HTMLElement | null>(null);
  // Next reloads .env.local by itself within seconds: read every second until each key saved here reads Set.
  const state = useApi<Data>("connections", (d) => (d.save.mode === "local" && d.connections.some((c) => c.state === "saved") ? 1000 : undefined));
  const { reload, data } = state;
  useEffect(() => onReleaseSettled((s) => {
    setSaved([]); reload();
    if (s === "failed") setRetry("The redeploy failed, so production still runs without your last change.");
  }), [reload]);
  useEffect(() => {
    // Leaving the page drops the form and what was typed; a page restored from the back/forward cache reads again.
    const hide = () => { setOpen(null); setMenu(""); }, show = (e: PageTransitionEvent) => e.persisted && reload();
    addEventListener("pagehide", hide); addEventListener("pageshow", show);
    return () => { removeEventListener("pagehide", hide); removeEventListener("pageshow", show); };
  }, [reload]);
  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => { if (!(e.target as Element).closest?.(".connection-menu")) setMenu(""); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(""); trigger.current?.focus(); } };
    document.querySelector<HTMLElement>(".connection-menu [role=menuitem]")?.focus();
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [menu]);
  if (!data) return <Status state={state} />;
  const { save } = data, local = save.mode === "local", canChange = local || save.mode === "hosted";
  const connections = only !== undefined ? data.connections.filter((c) => only?.includes(c.name)) : data.connections, n = connections.length;
  const where = data.environment === "local" ? "on this computer" : data.environment === "preview" ? "in Preview" : "in Production";
  const stateOf = (c: Connection): State => (saved.includes(c.name) && c.state === "set" ? "saved" : c.state);
  const labels = { set: "Set", missing: "Missing", saved: local ? "Saved, getting ready" : "Saved, going live", provided: "Provided by Vercel", readonly: "Read only" };
  // Hosted, "saved" from the server alone: in Vercel, but this deployment was built before it.
  const going = (c: Connection) => local || saved.includes(c.name), waiting = connections.filter((c) => stateOf(c) === "saved" && !going(c)).length;
  const missing = connections.filter((c) => stateOf(c) === "missing").length, pending = connections.some((c) => stateOf(c) === "saved" && going(c));
  // A workflow's tab (`only`): null when its registry entry names no keys at all, [] when it uses none.
  const summary = only === null ? "This workflow doesn't list the keys it uses yet." : only && !only.length ? "This workflow uses no keys."
    : !n ? (only ? "None of the keys this workflow uses is listed yet." : "No connections yet. Add one, or ask your agent to.")
    : missing ? `${missing} of ${n} ${n === 1 ? "key isn't" : "keys aren't"} set ${where}.`
    : pending ? `Your workflows can use the keys you saved ${local ? "in a few seconds" : "in about a minute"}.`
    : waiting ? `${waiting} saved ${waiting === 1 ? "key isn't" : "keys aren't"} live yet; the next production deployment uses ${waiting === 1 ? "it" : "them"}.`
    : `Every key ${only ? "this workflow uses " : ""}is set ${where}.`;
  const start = (e: { currentTarget: HTMLElement }, o: Open) => {
    trigger.current = e.currentTarget.closest(".connection-menu")?.querySelector("button") ?? e.currentTarget;
    setMenu(""); setNote(""); setOpen(o);
  };
  const close = () => { setOpen(null); requestAnimationFrame(() => trigger.current?.focus()); };
  const done = (o: Open, name: string, r: Done, action: string) => {
    close(); reload();
    if (r.id) releaseStarted(r.id);
    if (!local && r.id && o.kind !== "delete") setSaved((s) => [...s, name]);
    if (r.redeploy === "failed" || r.redeploy === "skipped") setRetry(r.status);
    else if (r.shell && o.kind !== "delete") setNote(`Saved, but your shell sets ${name} too, and that value wins while gtm dev runs. Unset it in your shell and restart gtm dev to use this one.`);
    else if (!local && !r.id && action !== "rename") setNote(r.status);
  };
  async function redeploy() {
    setBusy(true);
    await post({ action: "redeploy" }, save.csrf).then((r) => {
      setRetry(r.redeploy === "failed" || r.redeploy === "skipped" ? r.status : "");
      if (r.id) releaseStarted(r.id); else if (!r.redeploy) setNote(r.status);
    }, (err: Error) => setRetry(err.message));
    setBusy(false);
  }
  return (
    <div className="connections-view">
      {only !== undefined ? <div className="title-row"><p role="status">{summary}</p><Link className="button" href="/connections">All connections</Link></div> : <>
        <div className="title-row">
          <h1>Connections</h1>
          <div className="connection-actions">
            <button type="button" className="icon-button" aria-label="Refresh connections" title="Refresh connections" disabled={state.loading}
              onClick={reload}><Icon d={icons.refresh} /></button>
            {data.settingsUrl && <a className="button" href={data.settingsUrl} target="_blank" rel="noreferrer">Open in Vercel</a>}
            {canChange && <button type="button" className="primary" onClick={(e) => start(e, { kind: "add" })}>Add connection</button>}
          </div>
        </div>
        <p className="subtitle" role="status">{summary}</p>
      </>}
      <div className="page">
        <Status state={state} />
        {only === null && <p className="notice">Ask your agent to list the keys this workflow uses.</p>}
        {data.tokenWarning && <p className="banner warn">{data.tokenWarning}</p>}
        {save.mode === "off" && <p className="banner">{save.reason}</p>}
        {data.listError && <p className="banner warn">{data.listError}</p>}
        {retry && <div className="banner warn retry" role="alert"><span>{retry}</span>
          {save.mode === "hosted" && <button type="button" disabled={busy} onClick={redeploy}>{busy ? "Redeploying…" : "Redeploy"}</button>}</div>}
        {note && <p className="banner" role="status">{note}</p>}
        {n > 0 && <div className="connection-list">
          {connections.map((c) => {
            const s = stateOf(c), label = labelOf(c), edit = c.actions.includes("save") || c.actions.includes("rename");
            const items = [edit && "Edit", c.actions.includes("delete") && "Delete", data.settingsUrl && !local && "Open in Vercel"].filter(Boolean);
            return (
              <div className="connection-row" key={c.name}>
                <div className="connection-name">
                  <h3>{label}</h3>
                  {c.description && <p className="muted connection-variable">{c.name}</p>}
                  {!only && (c.usedBy.length ? <p className="muted connection-usage">{s === "missing" ? "Needed by" : "Used by"} {workflowLinks(c.usedBy)}</p>
                    : data.usageComplete && <p className="muted connection-usage">Not used by any workflow</p>)}
                  {c.shell && <p className="connection-usage connection-shell">Also set in your shell, which overrides it</p>}
                  {c.reserved && s !== "provided" && <p className="muted connection-usage">Set with the vendor's CLI or integration, not here</p>}
                </div>
                <span className="connection-state" data-state={s} title={s === "readonly" ? "Shared with other environments or owned by Vercel or an integration: change it in Vercel" : undefined}>
                  <Icon d={icons[s === "provided" ? "set" : s]} />{s === "saved" && !going(c) ? "Saved, not live yet" : labels[s]}
                </span>
                <div className="connection-buttons">
                  {s === "missing" && c.actions.includes("save") && <button type="button" className="primary" aria-label={`Add ${label}`}
                    onClick={(e) => start(e, { kind: "add", c })}>Add</button>}
                  {items.length > 0 && <div className="connection-menu">
                    <button type="button" className="icon-button" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={menu === c.name}
                      onClick={(e) => { trigger.current = e.currentTarget; setMenu(menu === c.name ? "" : c.name); }}><Icon d={icons.more} /></button>
                    {menu === c.name && <div role="menu">
                      {edit && <button type="button" role="menuitem" onClick={(e) => start(e, { kind: "edit", c })}>Edit</button>}
                      {c.actions.includes("delete") && <button type="button" role="menuitem" className="danger-text" onClick={(e) => start(e, { kind: "delete", c })}>Delete</button>}
                      {items.includes("Open in Vercel") && <a role="menuitem" href={data.settingsUrl!} target="_blank" rel="noreferrer" onClick={() => setMenu("")}>Open in Vercel</a>}
                    </div>}
                  </div>}
                </div>
              </div>
            );
          })}
        </div>}
      </div>
      {open && <ConnectionDialog {...open} local={local} csrf={save.csrf} existing={data.connections} close={close}
        done={(name, r, action) => done(open, name, r, action)} />}
    </div>
  );
}

/**
 * Add, Edit or Delete one connection in a modal. A value is sent once and never shown again; Edit with no value only
 * renames. Escape or Cancel closes it unless it is sending.
 */
function ConnectionDialog({ kind, c, local, csrf, existing, close, done }: Open & { local: boolean; csrf?: string; existing: Connection[];
  close: () => void; done: (name: string, r: Done, action: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [label, setLabel] = useState(c?.description ?? ""), [name, setName] = useState(c?.name ?? ""), [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    // Typed values never outlive the page: cleared on pagehide (before the back/forward cache keeps it) and on close.
    const clear = () => { setValue(""); if (input.current) input.current.value = ""; };
    addEventListener("pagehide", clear);
    return () => { removeEventListener("pagehide", clear); clear(); };
  }, []);
  const renames = kind === "edit" && c!.actions.includes("rename"), changed = value !== "" || (renames && label.trim() !== c!.description);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError("");
    const key = name.trim(), there = existing.find((x) => x.name === key);
    if (kind === "add" && !c && there && there.state !== "missing") return setError(`${key} already exists. Close this and use Edit on its row.`);
    setBusy(true);
    const body = kind === "delete" ? { action: "delete", name: key } : value ? { action: "save", name: key, value, label: label.trim() } : { action: "rename", name: key, label: label.trim() };
    await post(body, csrf).then((r) => { setValue(""); done(key, r, body.action); }, (err: Error) => { setError(err.message); setBusy(false); });
  }
  const used = c?.usedBy ?? [];
  return (
    <dialog ref={dialog} className="connection-dialog" aria-labelledby="connection-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit} autoComplete="off">
        <h2 id="connection-title">{kind === "delete" ? `Delete ${labelOf(c!)}?` : kind === "edit" ? "Edit connection" : "Add connection"}</h2>
        {kind === "delete" ? <>
          <p className="connection-warning">{used.length ? <>Used by {workflowLinks(used)}. {used.length === 1 ? "It stops" : "They stop"} working until the key is added again.</>
            : "No workflow lists it as used."}</p>
          {!local && <p className="muted">Production redeploys without it.</p>}
        </> : <div className="connection-fields">
          <label htmlFor="connection-label">Name</label>
          <input id="connection-label" name="label" placeholder="Apollo" maxLength={256} required={kind === "add" || renames} disabled={kind === "edit" && !renames}
            autoFocus={!c} value={label} onChange={(e) => setLabel(e.target.value)} />
          <label htmlFor="connection-key">Key</label>
          <input id="connection-key" name="key" placeholder="APOLLO_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={256} required spellCheck={false}
            readOnly={Boolean(c)} title="Letters, digits and _, not starting with a digit" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} />
          <label htmlFor="connection-value">{kind === "edit" ? "New value" : "Value"}</label>
          <input ref={input} id="connection-value" name="value" type="password" autoComplete="new-password" spellCheck={false} maxLength={32_768} required={!renames}
            className={renames ? undefined : "secret"} autoFocus={Boolean(c)} placeholder={renames ? "Leave empty to keep the current value" : "apk_7f3k9q2m"}
            value={value} onChange={(e) => setValue(e.target.value)} />
        </div>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className={`primary connection-submit${kind === "delete" ? " danger" : ""}`} disabled={busy || (kind === "edit" && !changed)} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? (kind === "delete" ? "Deleting…" : "Saving…") : kind === "delete" ? "Delete connection" : "Save connection"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
