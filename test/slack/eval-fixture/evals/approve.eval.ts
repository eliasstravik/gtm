import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

const recorded = async () => (await (await fetch(`http://127.0.0.1:${process.env.GTM_PORT}/__requests`)).json()) as { url: string; body: string }[];

export default defineEval({
  description: "start_run waits for an approval, and only an approval starts the run",
  async test(t) {
    const before = (await recorded()).length;
    const turn = await t.send("Run a preview of the enrich workflow.");
    const request = turn.session.requireInputRequest({ toolName: "start_run" });
    t.check(request.kind, equals("tool-approval"));
    t.check(request.prompt, equals("Start enrich? Preview of 5 rows, about $0.04."));
    t.check((await recorded()).length, equals(before));
    const done = await turn.session.respond([{ requestId: request.requestId, optionId: "approve" }]);
    t.check(done.message ?? "", includes("wrun_"));
    const calls = (await recorded()).slice(before);
    t.check(calls.length, equals(1));
    t.check(calls[0]?.url ?? "", equals("/api/gtm/start/enrich"));
    t.check(calls[0]?.body ?? "", equals('{"limit":5}'));
  },
});
