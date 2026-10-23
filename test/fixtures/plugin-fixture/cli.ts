import type { CliCtx } from "@eliasstravik/gtm/cli";

export default async function fixture(args: string[], ctx: CliCtx): Promise<void> {
  console.log(`fixture says hello (${ctx.plugin}, ${args.join(" ") || "no args"})`);
}
