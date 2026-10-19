import { defaultSlackAuth, slackChannel, type SlackInboundMessageContext, type SlackMessage } from "eve/channels/slack";
import { allowed } from "../lib/allowlist";

/** A message starts a turn only from a full member of the company's Slack, in a conversation not shared outside it. */
async function admit(ctx: SlackInboundMessageContext, message: SlackMessage) {
  return (await allowed(ctx.slack, message.author?.userId, message.channelId)) ? { auth: defaultSlackAuth(message, ctx) } : null;
}

/**
 * Slack at /eve/v1/slack. Credentials: SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET (eve reads them when `credentials` is
 * omitted). Every entry hook runs the same allowlist (lib/allowlist.ts); a hook eve has but this agent does not use is
 * still defined, so anything added to it later sits behind the check.
 */
export default slackChannel({
  onAppMention: admit,
  onDirectMessage: admit,
  // Without a mention, a message counts only in a thread this agent is already working in.
  onMessage: async (ctx, message) => ((await ctx.isSubscribed()) ? admit(ctx, message) : null),
  // A click on an approval card. The tools' approval policy (lib/approval.ts) then accepts only the person who asked.
  onInputResponse: async (ctx, submission) =>
    (await allowed(ctx.slack, submission.user.id, ctx.slack.channelId)) ? { auth: ctx.defaultAuth } : null,
  async onSlashCommand(command, ctx) {
    if (!(await allowed(ctx.slack, command.user.id, command.channelId))) return;
  },
  async onShortcut(shortcut, ctx) {
    if (!(await allowed(ctx.slack, shortcut.user.id, shortcut.type === "message_action" ? shortcut.channelId : undefined))) return;
  },
  async onInteraction(action, ctx) {
    if (!(await allowed(ctx.slack, action.user.id, ctx.slack.channelId))) return;
  },
  async onEvent(ctx, event) {
    const user = typeof event.user === "string" ? event.user : undefined;
    const channel = typeof event.channel === "string" ? event.channel : undefined;
    if (!channel || !(await allowed(ctx.slack, user, channel))) return;
  },
});
