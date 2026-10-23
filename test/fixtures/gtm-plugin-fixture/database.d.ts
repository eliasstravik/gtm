import type { Ctx, DatabaseSlotV1 } from "@eliasstravik/gtm";
export default function swapped(ctx: Ctx): DatabaseSlotV1 & { swapped: true };
