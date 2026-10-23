/** Reconcile's listing of SDK runs pages until it reaches the cursor, so a backlog of any size is never skipped. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setWorld } from "workflow/runtime";
import { sdkRuns } from "../../dist/plugins/workflows/sdk.js";

test("2,101 runs waiting for discovery: one pass lists them all, the next only the overlap", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const all = Array.from({ length: 2101 }, (_, i) => ({ runId: `wrun_${i}`, status: "completed", workflowName: "x",
    createdAt: new Date(start + i * 1000), completedAt: new Date(start + i * 1000), attributes: {} })).reverse();
  setWorld({
    specVersion: 8,
    runs: {
      list: async ({ pagination: { limit, cursor } }) => {
        const at = cursor ? Number(cursor) : 0, data = all.slice(at, at + limit);
        return { data, cursor: at + limit < all.length ? String(at + limit) : null, hasMore: at + limit < all.length };
      },
    },
  });
  const first = await sdkRuns({}, "-infinity");
  assert.equal(first.length, 2101);
  const newest = first[0].createdAt;
  const again = await sdkRuns({}, new Date(Date.parse(newest) - 5 * 60_000).toISOString());
  assert.equal(again.length, 301, "the five-minute overlap only");
});
