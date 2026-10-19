// Module hooks so node:test can import the agent template the way eve's bundler does: extensionless relative imports
// resolve to `.ts` (Node strips the types), and bare imports this repo does not install (eve, until it is a
// devDependency) resolve from GTM_TEST_NODE_MODULES when that is set.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error;
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    const modules = process.env.GTM_TEST_NODE_MODULES;
    if (modules && !/^[./]/.test(specifier)) return next(specifier, { ...context, parentURL: pathToFileURL(join(modules, "_.mjs")).href });
    throw error;
  }
}
