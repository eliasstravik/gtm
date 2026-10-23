// Inbound webhooks: { <name>: webhook({ verify, dedupe, onEvent }) }, served at /api/gtm/hooks/<name>
// (`npx gtm docs webhooks`).
import type { Webhooks } from "@eliasstravik/gtm/workflows";

export const webhooks = {} satisfies Webhooks;
