// Unit tests of the Slack allowlist (slack/agent/lib/allowlist.ts) against recorded-shape Slack responses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { authTest, authTestGrid, conversations, ENTERPRISE, GRID_SISTER_TEAM, TEAM, users } from "./fixtures.mjs";
import { missingEve, template } from "./helpers.mjs";

const skip = (await missingEve()) ?? false;

/** An in-memory `ctx.slack`: answers from the fixtures, records calls, and can fail one method. */
function slack({ auth = authTest, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, body) {
      calls.push(method);
      if (fail[method] === "throw") throw new Error(`Slack ${method} returned HTTP 500`);
      if (fail[method]) return { ok: false, error: fail[method] };
      if (method === "auth.test") return auth;
      if (method === "users.info") return users[body.user] ?? { ok: false, error: "user_not_found" };
      if (method === "conversations.info") return conversations[body.channel] ?? { ok: false, error: "channel_not_found" };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("isMember: only full members of the company's workspace", { skip }, async () => {
  const { isMember } = await template("lib/allowlist");
  const company = { teamId: TEAM };
  assert.equal(isMember(users.U0MEMBER01.user, company), true);
  for (const id of ["U0GUEST001", "U0SINGLE01", "U0BOTUSER1", "U0DELETED1", "U0EXTERNAL", "W0GRIDSIS1"]) {
    assert.equal(isMember(users[id].user, company), false, id);
  }
  const { is_restricted: _, ...noFlag } = users.U0MEMBER01.user;
  assert.equal(isMember(noFlag, company), false, "a missing guest flag refuses");
});

test("isMember on Enterprise Grid: any workspace of the same org, never another org", { skip }, async () => {
  const { isMember } = await template("lib/allowlist");
  const company = { teamId: TEAM, enterpriseId: ENTERPRISE };
  assert.equal(isMember(users.U0MEMBER01.user, company), true);
  assert.equal(isMember(users.W0GRIDSIS1.user, company), true, `member of ${GRID_SISTER_TEAM} in the same grid`);
  assert.equal(isMember(users.W0GRIDOTH1.user, company), false, "other enterprise");
  assert.equal(isMember(users.U0EXTERNAL.user, company), false, "other team, no grid");
  assert.equal(isMember({ ...users.W0GRIDSIS1.user, is_restricted: true }, company), false, "grid guest");
});

test("isInternal: refuses Slack Connect and pending Slack Connect conversations", { skip }, async () => {
  const { isInternal } = await template("lib/allowlist");
  for (const id of ["C0PUBLIC01", "G0PRIVATE1", "C0ORGSHARE", "D0DIRECT01"]) assert.equal(isInternal(conversations[id].channel), true, id);
  for (const id of ["C0CONNECT1", "C0PENDING1"]) assert.equal(isInternal(conversations[id].channel), false, id);
});

test("allowed: member in an internal conversation; everyone else refused", { skip }, async () => {
  const { allowed } = await template("lib/allowlist", "cases");
  const api = slack();
  assert.equal(await allowed(api, "U0MEMBER01", "C0PUBLIC01"), true);
  assert.equal(await allowed(api, "U0MEMBER01", "G0PRIVATE1"), true);
  assert.equal(await allowed(api, "U0MEMBER01", "D0DIRECT01"), true);
  assert.equal(await allowed(api, "U0MEMBER01", undefined), true, "global shortcut: user check only");
  const refused = [
    ["U0GUEST001", "C0PUBLIC01", "guest"], ["U0SINGLE01", "C0PUBLIC01", "single-channel guest"],
    ["U0BOTUSER1", "C0PUBLIC01", "bot"], ["U0DELETED1", "C0PUBLIC01", "deleted"], ["U0EXTERNAL", "C0PUBLIC01", "other team"],
    ["W0GRIDSIS1", "C0PUBLIC01", "grid user while the company is not on grid"],
    ["U0MEMBER01", "C0CONNECT1", "Slack Connect channel"], ["U0MEMBER01", "C0PENDING1", "pending Slack Connect"],
    ["U0MISSING1", "C0PUBLIC01", "users.info error"], ["U0MEMBER01", "C0MISSING1", "conversations.info error"],
    [undefined, "C0PUBLIC01", "no user id"], ["", "C0PUBLIC01", "empty user id"],
  ];
  for (const [user, channel, why] of refused) assert.equal(await allowed(api, user, channel), false, why);
  assert.equal(api.calls.filter((m) => m === "auth.test").length, 1, "auth.test is read once per instance");
});

test("allowed: any Slack API failure refuses, and a failed auth.test is not cached", { skip }, async () => {
  const { allowed } = await template("lib/allowlist", "failures");
  assert.equal(await allowed(slack({ fail: { "auth.test": "invalid_auth" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(slack({ fail: { "auth.test": "throw" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(slack({ fail: { "users.info": "throw" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(slack({ fail: { "users.info": "ratelimited" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(slack({ fail: { "conversations.info": "missing_scope" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(slack(), "U0MEMBER01", "C0PUBLIC01"), true, "recovers once Slack answers");
  const fresh = await template("lib/allowlist", "no-team");
  assert.equal(await fresh.allowed(slack({ auth: { ok: true, team: "x" } }), "U0MEMBER01", "C0PUBLIC01"), false, "auth.test without team_id");
});

test("allowed: the company comes from auth.test, so a Grid install admits sister workspaces", { skip }, async () => {
  const { allowed } = await template("lib/allowlist", "grid");
  const api = slack({ auth: authTestGrid });
  assert.equal(await allowed(api, "W0GRIDSIS1", "C0ORGSHARE"), true);
  assert.equal(await allowed(api, "U0MEMBER01", "C0PUBLIC01"), true);
  assert.equal(await allowed(api, "W0GRIDOTH1", "C0ORGSHARE"), false);
  assert.equal(await allowed(api, "W0GRIDSIS1", "C0CONNECT1"), false);
});
