import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const recorded = async () => (await (await fetch(`http://127.0.0.1:${process.env.GTM_PORT}/__requests`)).json()) as unknown[];

export default defineEval({
  description: "a cancelled approval starts nothing",
  async test(t) {
    const before = (await recorded()).length;
    const turn = await t.send("Run a preview of the enrich workflow.");
    const request = turn.session.requireInputRequest({ toolName: "start_run" });
    await turn.session.respond([{ requestId: request.requestId, optionId: "cancel" }]);
    t.check((await recorded()).length, equals(before));
  },
});
