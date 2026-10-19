import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const recorded = async () => (await (await fetch(`http://127.0.0.1:${process.env.GTM_PORT}/__requests`)).json()) as unknown[];
const bob = `Basic ${Buffer.from("bob:bob-password").toString("base64")}`;

export default defineEval({
  description: "a yes from someone other than the requester is refused; the requester's own yes starts the run",
  async test(t) {
    const before = (await recorded()).length;
    const turn = await t.send("Run a preview of the enrich workflow.");
    const request = turn.session.requireInputRequest({ toolName: "start_run" });
    const answer = await t.target.fetch(`/eve/v1/session/${turn.sessionId}`, {
      method: "POST",
      headers: { authorization: bob, "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }),
    });
    t.check(answer.status, equals(202));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    t.check((await recorded()).length, equals(before));
    // The refusal ends in its own turn.waiting boundary, so the eval client's respond can settle on it: poll for the run.
    await turn.session.respond([{ requestId: request.requestId, optionId: "approve" }]);
    let calls = (await recorded()).length;
    for (let i = 0; i < 40 && calls === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      calls = (await recorded()).length;
    }
    t.check(calls, equals(before + 1));
    const refused = turn.session.events.find((e) => e.type === "approval.candidate" && (e.data as { outcome?: string }).outcome === "rejected");
    t.check((refused?.data as { reason?: string } | undefined)?.reason ?? "", equals("Only the person who asked can answer this."));
  },
});
