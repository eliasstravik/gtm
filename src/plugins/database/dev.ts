/** gtm dev's database: PGlite on 127.0.0.1 when DATABASE_URL is unset, then pending migrations. */
import type { DevCtx, DevHandle } from "@eliasstravik/gtm/cli";
import { value } from "@eliasstravik/gtm/kit";
import { type LocalDatabase, startDevDatabase } from "./localdb.js";
import { migrate } from "./cli.js";

export default async function databaseDev(ctx: DevCtx): Promise<DevHandle> {
  let local: LocalDatabase | undefined;
  if (!value("DATABASE_URL")) {
    local = await startDevDatabase(ctx.dir);
    ctx.env.DATABASE_URL = local.url;
    console.log(`gtm dev: local database at ${local.url}`);
  }
  try {
    await migrate(ctx.dir, ctx.config, local?.url ?? value("DATABASE_URL")!);
  } catch (error) {
    await local?.stop();
    throw error;
  }
  return { stop: () => local?.stop() };
}
