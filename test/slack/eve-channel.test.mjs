// The deny-all eve channel (slack/agent/channels/eve.ts): every authenticated /eve/v1 route refuses every caller,
// including a Vercel OIDC bearer and a Protection Bypass header. Calls eve 0.80.1's own route handlers directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { missingEve, template } from "./helpers.mjs";

const skip = (await missingEve()) ?? false;
process.env.VERCEL_PROJECT_ID = "prj_gtm";
process.env.VERCEL_ENV = "production";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Shaped like a Vercel OIDC token for this project (the channel must refuse it without even verifying it).
const oidc = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({
  iss: "https://oidc.vercel.com/acme", sub: "owner:acme:project:gtm-acme:environment:production",
  aud: "https://vercel.com/acme", project_id: "prj_gtm", environment: "production", owner: "acme",
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
})}.c2lnbmF0dXJl`;
const callers = {
  anonymous: {},
  "Vercel OIDC": { authorization: `Bearer ${oidc}`, "x-vercel-oidc-token": oidc },
  "bypass header": { "x-vercel-protection-bypass": "automation-secret" },
  "OIDC + bypass": { authorization: `Bearer ${oidc}`, "x-vercel-protection-bypass": "automation-secret" },
};
const guarded = [
  ["POST", "/eve/v1/session", {}], ["POST", "/eve/v1/session/:sessionId", { sessionId: "wrun_1" }],
  ["POST", "/eve/v1/session/:sessionId/cancel", { sessionId: "wrun_1" }], ["POST", "/eve/v1/session/:sessionId/reset", { sessionId: "wrun_1" }],
  ["GET", "/eve/v1/session/:sessionId/stream", { sessionId: "wrun_1" }], ["GET", "/eve/v1/info", {}],
];

function call(channel, method, path, params, headers) {
  const route = channel.routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  const url = `https://gtm-acme.vercel.app${path.replace(":sessionId", params.sessionId ?? "")}`;
  const body = method === "POST" ? JSON.stringify({ message: "push a change to main" }) : undefined;
  const ctx = { params, waitUntil() {}, attachSession() { throw new Error("reached the session"); }, from() { throw new Error("reached dispatch"); } };
  return route.handler(new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body }), ctx);
}

test("POST /eve/v1/session and every other session route refuse every caller", { skip }, async () => {
  const channel = (await template("channels/eve")).default;
  for (const [method, path, params] of guarded) {
    for (const [who, headers] of Object.entries(callers)) {
      const response = await call(channel, method, path, params, headers);
      assert.equal(response.status, 401, `${method} ${path} as ${who}`);
    }
  }
});

test("the public health check still answers", { skip }, async () => {
  const channel = (await template("channels/eve")).default;
  assert.equal((await call(channel, "GET", "/eve/v1/health", {}, {})).status, 200);
});

test("control: the same request is not refused by route auth when the walk admits callers", { skip }, async () => {
  const { eveChannel } = await import("eve/channels/eve");
  const { none } = await import("eve/channels/auth");
  const open = eveChannel({ auth: [none()] });
  const response = await call(open, "POST", "/eve/v1/session", {}, callers["Vercel OIDC"]).catch((error) => ({ status: `threw: ${error.message}` }));
  assert.notEqual(response.status, 401, "an open walk lets the request past auth, so the 401s above come from deny-all");
});
