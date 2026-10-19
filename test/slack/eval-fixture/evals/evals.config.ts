import { createServer } from "node:http";
import { defineEvalConfig } from "eve/evals";

// A fake gtm API on 127.0.0.1:$GTM_PORT that records what the agent's start_run tool sends.
export default defineEvalConfig({
  maxConcurrency: 1,
  async setup() {
    const requests: { method?: string; url?: string; body: string; bypass?: string }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/__requests") return res.end(JSON.stringify(requests));
      requests.push({ method: req.method, url: req.url, body, bypass: req.headers["x-vercel-protection-bypass"] as string | undefined });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ runId: `wrun_${requests.length}` }));
    });
    await new Promise<void>((resolve) => server.listen(Number(process.env.GTM_PORT), "127.0.0.1", resolve));
    return { server };
  },
  async teardown(context) {
    await new Promise((resolve) => context?.server.close(resolve));
  },
});
