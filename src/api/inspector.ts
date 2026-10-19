/** The Workflow SDK's own run inspector, served by the local Console under /api/gtm/inspector (filled in by GTM-7). */
import { HttpError } from "./http.js";

/** Any method on /api/gtm/inspector/** → the inspector's response. Local only. */
export async function inspector(_req: Request, _rest: string[]): Promise<Response> {
  throw new HttpError(404, "The run inspector is not built yet");
}
