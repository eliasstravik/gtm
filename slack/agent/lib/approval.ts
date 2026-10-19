import type { SessionAuthContext } from "eve/context";
import type { ApprovalResponsePolicy } from "eve/tools/approval";

function samePrincipal(a: SessionAuthContext, b: SessionAuthContext): boolean {
  return a.authenticator === b.authenticator && a.issuer === b.issuer
    && a.principalType === b.principalType && a.principalId === b.principalId;
}

/**
 * Only the person who asked for the call can approve or cancel it. A click from anyone else is refused and the request
 * stays pending; a typed "yes" never counts, because channels/slack.ts defines onInputResponse.
 */
export const requesterOnly: ApprovalResponsePolicy<any> = ({ request, response }) =>
  request.principal !== null && samePrincipal(response.principal, request.principal)
    ? { status: "allowed" }
    : { status: "rejected", reason: "Only the person who asked can answer this." };
