"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { onReleaseSettled, releaseStarted } from "./environment.js";
import { api, Status, useApi } from "./load.js";
import "./connections.css";

type Connection = { name: string; description: string; set: boolean };
type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; settingsUrl?: string; csrf?: string };
type Saved = { ok: true; status: string; id?: string };
/** Heroicons 16 solid: check-circle, x-circle, clock. */
const icons = {
  set: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z",
  missing: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z",
  saved: "M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z",
};

/**
 * Connections: each key `.env.example` lists, by its comment, and whether it is set here, never its value. Add or
 * Replace sends one value: locally into .env.local, hosted into Vercel's Production env, which then redeploys.
 */
export function ConnectionsView() {
  // Keys saved from this page: "getting ready" locally until the server reads them, "going live" until the redeploy is.
  const [saved, setSaved] = useState<string[]>([]), [note, setNote] = useState("");
  const [editing, setEditing] = useState<{ c: Connection; verb: string } | null>(null), trigger = useRef<HTMLButtonElement>(null);
  // Next reloads .env.local by itself within seconds: read every second until each key saved here reads Set.
  const state = useApi<{ connections: Connection[]; environment: string; save: Save; tokenWarning: string | null }>("connections",
    (d) => (d.save.mode === "local" && d.connections.some((c) => !c.set && saved.includes(c.name)) ? 1000 : undefined));
  const { reload, data } = state;
  useEffect(() => onReleaseSettled(() => { setSaved([]); reload(); }), [reload]);
  if (!data) return <Status state={state} />;
  const { connections, save } = data, n = connections.length, local = save.mode === "local", canSave = local || save.mode === "hosted";
  const where = data.environment === "local" ? "on this computer" : data.environment === "preview" ? "in Preview" : "in Production";
  const stateOf = (c: Connection) => (saved.includes(c.name) && !(local && c.set) ? "saved" : c.set ? "set" : "missing");
  const labels = { set: "Set", missing: "Missing", saved: local ? "Saved, getting ready" : "Saved, going live" };
  const missing = connections.filter((c) => stateOf(c) === "missing").length, pending = connections.some((c) => stateOf(c) === "saved");
  const summary = !n ? "No connections yet. Your agent lists them in .env.example."
    : missing ? `${missing} of ${n} ${n === 1 ? "key isn't" : "keys aren't"} set ${where}.`
    : pending ? `Your workflows can use the keys you saved ${local ? "in a few seconds" : "in about a minute"}.`
    : `Every key is set ${where}.`;
  const close = () => { setEditing(null); requestAnimationFrame(() => trigger.current?.focus()); };
  const done = (c: Connection, r: Saved) => {
    close(); reload();
    if (r.id) releaseStarted(r.id);
    // Hosted without an id: saved, but nothing redeploys (a rollback pins production, or there is no deployment yet).
    if (local || r.id) setSaved((s) => [...s, c.name]); else setNote(r.status);
  };
  return (
    <div className="connections-view">
      <div className="title-row">
        <div><h1>Connections</h1><p className="muted" role="status">{summary}</p></div>
        {save.mode === "link" && <a className="button" href={save.settingsUrl} target="_blank" rel="noreferrer">Open in Vercel</a>}
      </div>
      <div className="page">
        <Status state={state} />
        {data.tokenWarning && <p className="banner warn">{data.tokenWarning}</p>}
        {save.mode === "off" && <p className="banner">{save.reason}</p>}
        {note && <p className="banner" role="status">{note}</p>}
        {n > 0 && <div className="connection-list">
          {connections.map((c) => {
            const s = stateOf(c), verb = s === "missing" ? "Add" : "Replace";
            return (
              <div className="connection-row" key={c.name}>
                <div className="connection-name">
                  <h3>{c.description || c.name}</h3>
                  {c.description && <p className="muted connection-variable">{c.name}</p>}
                </div>
                <span className="connection-state" data-state={s}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={icons[s]} /></svg>{labels[s]}
                </span>
                {canSave ? <button type="button" className={verb === "Add" ? "primary" : undefined} aria-label={`${verb} ${c.name}`}
                  onClick={(e) => { trigger.current = e.currentTarget; setNote(""); setEditing({ c, verb }); }}>{verb}</button> : <span aria-hidden="true" />}
              </div>
            );
          })}
        </div>}
        {canSave && n > 0 && <p className="muted connection-hint">
          {local ? "Saved to .env.local on this computer. Values are never shown here." : "Saved to Production on Vercel; production redeploys."}
        </p>}
      </div>
      {editing && <ConnectionDialog {...editing} csrf={save.csrf} close={close} done={(r) => done(editing.c, r)} />}
    </div>
  );
}

/** Add or Replace one key's value in a modal: sent once, never shown again. Escape or Cancel closes it unless saving. */
function ConnectionDialog({ c, verb, csrf, close, done }: { c: Connection; verb: string; csrf?: string; close: () => void; done: (r: Saved) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [value, setValue] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const headers = { "content-type": "application/json", ...(csrf && { "x-gtm-csrf": csrf }) };
    await api<Saved>("connections", { method: "POST", headers, body: JSON.stringify({ name: c.name, value }) })
      .then(done, (err: Error) => { setError(err.message); setBusy(false); });
  }
  return (
    <dialog ref={dialog} className="connection-dialog" aria-labelledby="connection-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit} autoComplete="off">
        <h2 id="connection-title">{verb} {c.name}</h2>
        {c.description && <p className="muted">{c.description}</p>}
        <div className="connection-fields">
          <label htmlFor="connection-value">{verb === "Add" ? "Value" : "New value"}</label>
          <input id="connection-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={32_768}
            value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className="primary connection-submit" disabled={busy || !value} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? "Saving…" : "Save connection"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
