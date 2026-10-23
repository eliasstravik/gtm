import type { Ctx, Manifest, SlotMap } from "../core/types.js";

const INSTANCES = Symbol.for("@eliasstravik/gtm/slot-instances");

/**
 * Plugin code's context inside steps and routes, built from the manifest and that plugin's slot map. One instance per
 * slot and manifest in a process, so every caller shares the same provider.
 */
export function context(manifest: Manifest, map: SlotMap): Ctx {
  const g = globalThis as { [INSTANCES]?: WeakMap<Manifest, Map<string, unknown>> };
  const store = (g[INSTANCES] ??= new WeakMap());
  if (!store.has(manifest)) store.set(manifest, new Map());
  const instances = store.get(manifest)!;
  const options = manifest.plugins.find((p) => p.name === map.plugin)?.options ?? {};
  const ctx: Ctx = {
    manifest, plugin: map.plugin, options,
    has: (slot: string) => Object.hasOwn(map.slots, slot),
    get: ((slot: string) => {
      const entry = map.slots[slot];
      if (!entry) throw new Error(`The ${map.plugin} plugin has no "${slot}" slot: add it to its needs or uses, or add a plugin that provides it, then run gtm sync.`);
      const key = `${slot}:${entry.plugin}`;
      if (!instances.has(key)) {
        const provide = entry.provide as { default?: (c: Ctx) => unknown } | ((c: Ctx) => unknown);
        const make = typeof provide === "function" ? provide : provide.default!;
        instances.set(key, make(context(manifest, entry.map.default)));
      }
      return instances.get(key);
    }) as Ctx["get"],
    module: async <T>(name: string) => {
      const load = map.modules[name];
      if (!load) throw new Error(`The ${map.plugin} plugin has no project module "${name}"`);
      return (await load()) as T;
    },
  };
  return ctx;
}
