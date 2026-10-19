"use client";
import { useState, type FormEvent } from "react";
import { api, Pending, useApi } from "./load.js";

type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; settingsUrl?: string; csrf?: string };
type Connection = { name: string; description: string; set: boolean };
type Connections = { connections: Connection[]; save: Save; tokenWarning: string | null };
type Saved = { ok: true; status?: string; deploymentUrl?: string };

function Row({ c, save, onSaved }: { c: Connection; save: Save; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; url?: string }>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(undefined);
    try {
      const headers = { "content-type": "application/json", ...(save.csrf && { "x-gtm-csrf": save.csrf }) };
      const r = await api<Saved>("connections", { method: "POST", headers, body: JSON.stringify({ name: c.name, value }) });
      const url = r.deploymentUrl && (/^https?:\/\//.test(r.deploymentUrl) ? r.deploymentUrl : `https://${r.deploymentUrl}`);
      setValue("");
      setNote({ ok: true, text: r.status ?? (save.mode === "local" ? "Saved to .env.local." : "Saved."), url });
      onSaved();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="gtm-row">
      <div>
        <code>{c.name}</code>
        <span className={`gtm-badge ${c.set ? "gtm-ok" : "gtm-muted"}`}>{c.set ? "set" : "missing"}</span>
        {c.description && <div className="gtm-muted">{c.description}</div>}
        {note && (
          <div className={note.ok ? "gtm-ok" : "gtm-error"}>
            {note.text} {note.url && <a href={note.url} target="_blank" rel="noreferrer">Deployment ↗</a>}
          </div>
        )}
      </div>
      {(save.mode === "local" || save.mode === "hosted") && (
        <form onSubmit={submit}>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={c.set ? "New value" : "Value"}
            aria-label={`Value for ${c.name}`} autoComplete="off" spellCheck={false} />
          <button className="gtm-btn" disabled={busy || !value}>{busy ? "Saving…" : "Save"}</button>
        </form>
      )}
    </div>
  );
}

/** Connections: the names in `.env.example`, set or missing here. Values are never shown; Save writes one. */
export function ConnectionsView() {
  const { data, error, reload } = useApi<Connections>("connections");
  if (!data) return <Pending error={error} />;
  const { save } = data;
  return (
    <>
      {data.tokenWarning && <p className="gtm-banner gtm-warn">{data.tokenWarning}</p>}
      {save.mode === "off" && <p className="gtm-banner">{save.reason}</p>}
      {save.mode === "link" && (
        <p className="gtm-banner">
          Add or change keys in the <a href={save.settingsUrl} target="_blank" rel="noreferrer">project's Vercel settings ↗</a>.
        </p>
      )}
      <p className="gtm-muted">Values are never shown here, only whether each one is set.</p>
      {data.connections.length ? (
        <div className="gtm-list">{data.connections.map((c) => <Row key={c.name} c={c} save={save} onSaved={reload} />)}</div>
      ) : (
        <p className="gtm-muted">No connections yet. Your agent lists them in .env.example.</p>
      )}
    </>
  );
}
