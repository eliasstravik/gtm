/** gtm dev's reconcile: every 60 seconds, since crons never fire locally. */
import type { DevCtx, DevHandle } from "@eliasstravik/gtm/cli";

export default async function ledgerDev(ctx: DevCtx): Promise<DevHandle> {
  let timer: NodeJS.Timeout | undefined;
  const tick = () => fetch(`http://127.0.0.1:${ctx.port}/api/gtm/ledger/tick`, { method: "POST", signal: AbortSignal.timeout(50_000) })
    .then((r) => r.body?.cancel()).catch(() => {});
  return {
    started() { timer = setInterval(tick, 60_000); timer.unref(); },
    stop() { clearInterval(timer); },
  };
}
