import { isValidElement, type ReactNode } from "react";

type Row = unknown[] | Record<string, unknown>;

const json = (v: unknown) => {
  try { return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)) ?? String(v); } catch { return String(v); }
};

function cell(v: unknown): ReactNode {
  if (v == null) return <span className="gtm-muted">null</span>;
  if (isValidElement(v)) return v;
  const text = v instanceof Date ? v.toISOString() : typeof v === "object" ? json(v) : String(v);
  return <span title={text.length > 40 ? text : undefined}>{text}</span>;
}

/**
 * A read-only table. `rows` are arrays (matching `columns`) or objects (columns inferred from their keys when
 * `columns` is omitted). React elements render as they are; other objects as JSON text, never as HTML.
 */
export function Table({ columns, rows, empty = "No rows." }: { columns?: string[]; rows: Row[]; empty?: ReactNode }) {
  if (!rows.length) return <p className="gtm-muted">{empty}</p>;
  const cols = columns ?? (Array.isArray(rows[0]) ? rows[0].map((_, i) => String(i + 1)) : [...new Set(rows.flatMap((r) => Object.keys(r)))]);
  return (
    <div className="gtm-table">
      <table>
        <thead>
          <tr>{cols.map((c, j) => <th key={j}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c, j) => <td key={j}>{cell(Array.isArray(r) ? r[j] : r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
