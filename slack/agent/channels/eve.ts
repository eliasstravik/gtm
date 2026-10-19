import { eveChannel } from "eve/channels/eve";

/**
 * eve's HTTP session API, closed to every caller: an empty auth walk answers 401 to Vercel OIDC tokens, bypass headers
 * and `eve dev` alike. This agent takes commands only from Slack (channels/slack.ts). The public health check and eve's
 * callback routes, which check their own tokens, keep working.
 */
export default eveChannel({ auth: [] });
