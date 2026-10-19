import { httpBasic, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Eval fixture only (the shipped template is deny-all): `eve eval` drives the agent as the local-dev principal, and
// "bob" (HTTP Basic) is a second person who tries to answer someone else's approval.
export default eveChannel({ auth: [httpBasic({ username: "bob", password: "bob-password" }), localDev()] });
