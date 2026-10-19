// Integration tests: Slack-signed requests go through eve 0.80.1's own Slack route handler (verification, parsing,
// hook routing) into the template's hooks, which call a fake Slack Web API on 127.0.0.1. No real Slack.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TEAM } from "./fixtures.mjs";
import {
  approvalRequest, click, deliver, directMessage, eventBody, fakeSlack, mention, missingEve, signed, slashCommand, template, threadReply,
} from "./helpers.mjs";

const skip = (await missingEve()) ?? false;
const JSON_TYPE = "application/json";
const FORM = "application/x-www-form-urlencoded";
let slack, channel, requesterOnly;

before(async () => {
  if (skip) return;
  slack = await fakeSlack(4801);
  channel = (await template("channels/slack")).default;
  ({ requesterOnly } = await template("lib/approval"));
});
after(() => slack?.close());

const send = (body, type = JSON_TYPE, options) => deliver(channel, signed(body, type), options);

test("a mention from a full member starts a turn as that member", { skip }, async () => {
  const { status, sends } = await send(mention("U0MEMBER01", "C0PUBLIC01"));
  assert.equal(status, 200);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.auth.principalId, `slack:${TEAM}:U0MEMBER01`);
  assert.equal(sends[0].options.auth.authenticator, "slack-webhook");
  const checked = slack.calls("users.info").at(-1).params;
  assert.equal(checked.user, "U0MEMBER01");
  assert.equal(slack.calls("conversations.info").at(-1).params.channel, "C0PUBLIC01");
});

test("mentions from a guest, single-channel guest, bot, deleted or external user are refused", { skip }, async () => {
  for (const user of ["U0GUEST001", "U0SINGLE01", "U0BOTUSER1", "U0DELETED1", "U0EXTERNAL", "U0MISSING1"]) {
    const { status, sends } = await send(mention(user, "C0PUBLIC01"));
    assert.equal(status, 200, user);
    assert.equal(sends.length, 0, user);
  }
});

test("a member's mention in a Slack Connect or pending Slack Connect channel is refused", { skip }, async () => {
  for (const conversation of ["C0CONNECT1", "C0PENDING1"]) {
    assert.equal((await send(mention("U0MEMBER01", conversation))).sends.length, 0, conversation);
  }
});

test("the company is the bot's own auth.test team, not the event envelope's", { skip }, async () => {
  // A forged-looking envelope that claims the external user's team still does not make that user a member.
  const { sends } = await send(eventBody({ type: "app_mention", user: "U0EXTERNAL", channel: "C0PUBLIC01", text: "<@U0BOT00001> hi", ts: "1760000999.000100" }, "T0OTHER001"));
  assert.equal(sends.length, 0);
  assert.equal(slack.calls("auth.test").length, 1, "auth.test once per instance, cached");
});

test("Slack API errors refuse (fail closed)", { skip }, async () => {
  slack.state.fail["users.info"] = true;
  try {
    assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 0, "users.info HTTP 500");
  } finally {
    delete slack.state.fail["users.info"];
  }
  slack.state.fail["conversations.info"] = "missing_scope";
  try {
    assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 0, "conversations.info missing_scope");
  } finally {
    delete slack.state.fail["conversations.info"];
  }
  assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 1, "works again once Slack answers");
});

test("DMs: a member is admitted, a guest is refused", { skip }, async () => {
  assert.equal((await send(directMessage("U0MEMBER01"))).sends.length, 1);
  assert.equal((await send(directMessage("U0GUEST001"))).sends.length, 0);
});

test("unmentioned thread replies count only in a thread the agent works in, and only from members", { skip }, async () => {
  const thread = "1760000500.000100";
  assert.equal((await send(threadReply("U0MEMBER01", "C0PUBLIC01", thread))).sends.length, 0, "not subscribed");
  const subscribed = [thread];
  assert.equal((await send(threadReply("U0MEMBER01", "C0PUBLIC01", thread), JSON_TYPE, { subscribed })).sends.length, 1);
  assert.equal((await send(threadReply("U0GUEST001", "C0PUBLIC01", thread), JSON_TYPE, { subscribed })).sends.length, 0);
  assert.equal((await send(threadReply("U0MEMBER01", "C0CONNECT1", thread), JSON_TYPE, { subscribed })).sends.length, 0);
});

test("a request with a bad signature never reaches a hook", { skip }, async () => {
  const before = slack.state.calls.length;
  const { status, sends } = await deliver(channel, signed(mention("U0MEMBER01", "C0PUBLIC01"), JSON_TYPE, { secret: "wrong" }));
  assert.equal(status, 401);
  assert.equal(sends.length, 0);
  const stale = await deliver(channel, signed(mention("U0MEMBER01", "C0PUBLIC01"), JSON_TYPE, { age: 3600 }));
  assert.equal(stale.status, 401, "replayed (old timestamp)");
  assert.equal(slack.state.calls.length, before, "no Slack API call for unsigned traffic");
});

test("approval clicks: the requester's yes is delivered, a non-requester's is refused by the tool policy", { skip }, async () => {
  const thread = "1760000600.000100";
  const asked = await send(mention("U0MEMBER01", "C0PUBLIC01", { ts: thread }));
  const requester = asked.sends[0].options.auth;
  const request = approvalRequest("start_run", { workflow: "enrich", summary: "Preview, 5 rows, about $0.04" });

  const own = await send(await click(request, "approve", "U0MEMBER01", "C0PUBLIC01", thread), FORM);
  assert.equal(own.responds.length, 1, "onInputResponse admits the member");
  assert.deepEqual(own.responds[0].responses, [{ optionId: "approve", requestId: request.requestId }]);
  const responder = own.responds[0].options.auth;
  assert.deepEqual(await requesterOnly({ request: { principal: requester }, response: { decision: "approve", principal: responder } }), { status: "allowed" });

  const other = await send(await click(request, "approve", "U0MEMBER02", "C0PUBLIC01", thread), FORM);
  assert.equal(other.responds.length, 1, "another member's click reaches eve...");
  const verdict = await requesterOnly({ request: { principal: requester }, response: { decision: "approve", principal: other.responds[0].options.auth } });
  assert.equal(verdict.status, "rejected", "...and the tool's response policy refuses it, so the request stays pending");
  const cancel = await requesterOnly({ request: { principal: requester }, response: { decision: "cancel", principal: other.responds[0].options.auth } });
  assert.equal(cancel.status, "rejected", "nor can they cancel it");
});

test("approval clicks from a guest or in a Slack Connect channel never reach eve", { skip }, async () => {
  const request = approvalRequest("github", { command: 'gh-signed-commit --repo acme/gtm-acme --branch main -m "x"' });
  assert.equal((await send(await click(request, "approve", "U0GUEST001", "C0PUBLIC01", "1760000700.000100"), FORM)).responds.length, 0);
  assert.equal((await send(await click(request, "approve", "U0EXTERNAL", "C0PUBLIC01", "1760000700.000100", "T0OTHER001"), FORM)).responds.length, 0);
  assert.equal((await send(await click(request, "approve", "U0MEMBER01", "C0CONNECT1", "1760000700.000100"), FORM)).responds.length, 0);
});

test("slash commands, shortcuts and other events run the allowlist and start nothing, for anyone", { skip }, async () => {
  const checks = () => slack.calls("users.info").length;
  for (const user of ["U0MEMBER01", "U0GUEST001"]) {
    const posts = slack.calls("chat.postMessage").length;
    const inputs = [
      [slashCommand(user, "C0PUBLIC01"), FORM],
      [`payload=${encodeURIComponent(JSON.stringify({ type: "shortcut", callback_id: "gtm", trigger_id: "1.2.3", user: { id: user, team_id: TEAM }, team: { id: TEAM } }))}`, FORM],
      [eventBody({ type: "member_joined_channel", user, channel: "C0PUBLIC01", channel_type: "C" }), JSON_TYPE],
    ];
    for (const [body, type] of inputs) {
      const before = checks();
      const result = await send(body, type);
      assert.equal(result.status, 200);
      assert.equal(result.sends.length + result.responds.length, 0);
      assert.equal(checks(), before + 1, `the allowlist ran for ${user}: ${body.slice(0, 40)}`);
    }
    assert.equal(slack.calls("chat.postMessage").length, posts, "nothing posted");
  }
});
