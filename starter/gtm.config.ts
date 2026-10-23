// The project's plugins. Delete a line to remove a default plugin, then run `npx gtm sync`; `npx gtm check` says
// when another plugin needs it. `npx gtm docs plugins` explains the rest.
import { defineGtm } from "@eliasstravik/gtm";
import { database } from "@eliasstravik/gtm/database";
import { ledger } from "@eliasstravik/gtm/ledger";
import { workflows } from "@eliasstravik/gtm/workflows";
import { ai } from "@eliasstravik/gtm/ai";
import { context } from "@eliasstravik/gtm/context";
import { connections } from "@eliasstravik/gtm/connections";
import { console } from "@eliasstravik/gtm/console"; // shadows the global console in this file only

export default defineGtm({
  company: "Company",
  plugins: [
    database(),
    ledger({ budgets: { perRunUsd: 25, perWorkflowMonthUsd: 300, projectMonthUsd: 1000 } }),
    workflows({ registry: "./workflows", webhooks: "./webhooks" }),
    ai(),
    context(),
    connections(),
    console(),
  ],
  // acknowledge: { customLedger: true, destructive: ["company:0012"] },  // only when needed (`npx gtm docs ledger`)
});
