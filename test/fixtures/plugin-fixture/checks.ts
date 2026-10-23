import type { CheckResult } from "@eliasstravik/gtm";

export default async function checks(): Promise<CheckResult[]> {
  return [{ level: "info", message: "Fixture: its check ran." }];
}
