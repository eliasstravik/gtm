/** "Open database": Drizzle Studio on this computer, Neon's console when hosted (filled in by GTM-7). */
import { HttpError } from "./http.js";

/** /api/gtm/database[/…] → where "Open database" goes. */
export async function database(_req: Request, _rest: string[]): Promise<Response> {
  throw new HttpError(404, "Open database is not built yet");
}
