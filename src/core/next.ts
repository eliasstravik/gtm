import type { NextConfig } from "next";
import { allowedHosts } from "../kit/env.js";
import type { Manifest } from "./types.js";

type Phase = string;
type Context = { defaultConfig: NextConfig };
type ConfigInput = NextConfig | ((phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>);
/** A plugin's `next` module: a config transform, or one that needs Next's phase (as the Workflow SDK's does). */
export type NextTransform = (cfg: NextConfig) => NextConfig | ((phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>);

/**
 * The company's Next.js config with what the plugins add: each plugin's transform from gtm/next.ts in config order, the
 * files they trace, and allowed dev origins (GTM_ALLOWED_HOSTS). It enforces nothing; `gtm check` does.
 */
export function withGtm(config: ConfigInput = {}, gtm: { manifest: Manifest; transforms: NextTransform[]; trace?: string[] }) {
  return async (phase: Phase, ctx: Context): Promise<NextConfig> => {
    let cfg = typeof config === "function" ? await config(phase, ctx) : config;
    const includes = { ...cfg.outputFileTracingIncludes };
    includes["/**/*"] = [...new Set([...(includes["/**/*"] ?? []), ...(gtm.trace ?? [])])];
    cfg = { ...cfg, outputFileTracingIncludes: includes, allowedDevOrigins: [...new Set([...(cfg.allowedDevOrigins ?? []), ...allowedHosts()])] };
    for (const transform of gtm.transforms) {
      const next = transform(cfg);
      cfg = typeof next === "function" ? await next(phase, ctx) : next;
    }
    return cfg;
  };
}
