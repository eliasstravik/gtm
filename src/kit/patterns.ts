/** Route and view patterns: fixed segments, `:param` segments and a final `*`. Pure, for the proxy and the routes. */
export const segments = (path: string) => path.split("/").filter(Boolean);

/** Path segments decoded, or null when one is not valid percent-encoding. */
export function decodePath(path: string): string[] | null {
  try { return segments(path).map(decodeURIComponent); } catch { return null; }
}

const rank = (s: string) => (s === "*" ? 0 : s.startsWith(":") ? 1 : 2);

/** The parameters when `pattern` matches `path`, else null. */
export function match(pattern: string, path: string[]): Record<string, string> | null {
  const p = segments(pattern), params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === "*") { params["*"] = path.slice(i).join("/"); return params; }
    if (i >= path.length) return null;
    if (p[i].startsWith(":")) params[p[i].slice(1)] = path[i];
    else if (p[i] !== path[i]) return null;
  }
  return p.length === path.length ? params : null;
}

/** Sorts patterns most specific first: at the first differing segment a fixed one beats a parameter, which beats `*`. */
export function bySpecificity(a: string, b: string): number {
  const x = segments(a), y = segments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = rank(y[i] ?? "*") - rank(x[i] ?? "*");
    if (d) return d;
    if (rank(x[i] ?? "") === 2 && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return y.length - x.length;
}

/** The most specific of `items` whose pattern matches `path`, with its parameters. */
export function find<T extends { path: string }>(items: T[], path: string[], accept: (item: T) => boolean = () => true) {
  for (const item of [...items].sort((a, b) => bySpecificity(a.path, b.path))) {
    const params = match(item.path, path);
    if (params && accept(item)) return { item, params };
  }
  return undefined;
}

/** Two patterns that precedence cannot tell apart: the same segments, parameters counted as equal. */
export function sameShape(a: string, b: string): boolean {
  const x = segments(a), y = segments(b);
  return x.length === y.length && x.every((s, i) => (rank(s) === 2 ? s === y[i] : rank(s) === rank(y[i])));
}
