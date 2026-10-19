"use client";
import { useSearchParams } from "next/navigation.js";
import { Link, Pending, useApi } from "./load.js";
import { Table } from "./table.js";

type Tables = { tables: { name: string; estimatedRows: number | null }[] };
type Page = { table: string; columns: string[]; rows: unknown[][]; page: number; pageSize: number; hasMore: boolean };

const href = (table: string, page = 1) => `/data?table=${encodeURIComponent(table)}${page > 1 ? `&page=${page}` : ""}`;

/** Data: the `public` tables with estimated row counts; the selected table's rows 100 per page, and a CSV download. Read-only, no timers. */
export function DataView() {
  const params = useSearchParams();
  const list = useApi<Tables>("data");
  const table = params.get("table") ?? list.data?.tables[0]?.name ?? null;
  const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1); // pages are 1-based
  const rows = useApi<Page>(table && `data/${encodeURIComponent(table)}?page=${page}`);
  if (!list.data) return <Pending error={list.error} />;
  if (!list.data.tables.length) return <p className="gtm-muted">No tables yet. Workflows keep their results in their own tables.</p>;
  const r = rows.data;
  const first = r ? (r.page - 1) * r.pageSize : 0;
  return (
    <div className="gtm-cols">
      <nav className="gtm-side">
        <h4>Tables</h4>
        {list.data.tables.map((t) => (
          <Link key={t.name} href={href(t.name)} aria-current={t.name === table ? "page" : undefined}>
            <span className="gtm-mono">{t.name}</span>
            <span className="gtm-muted" title="Estimated rows">{t.estimatedRows == null ? "unknown" : t.estimatedRows.toLocaleString()}</span>
          </Link>
        ))}
      </nav>
      <section style={{ minWidth: 0 }}>
        {table && (
          <div className="gtm-head">
            <span className="gtm-mono">{table}</span>
            <span>
              {r && r.rows.length > 0 && `Rows ${first + 1}–${first + r.rows.length}`}
              <Link className="gtm-btn" href={href(table, page - 1)} aria-disabled={page <= 1 || undefined}>Prev</Link>
              <Link className="gtm-btn" href={href(table, page + 1)} aria-disabled={!r?.hasMore || undefined}>Next</Link>
              <a className="gtm-btn" href={`/api/gtm/data/${encodeURIComponent(table)}/csv`} download>CSV</a>
            </span>
          </div>
        )}
        {r ? <Table columns={r.columns} rows={r.rows} /> : <Pending error={rows.error} />}
      </section>
    </div>
  );
}
