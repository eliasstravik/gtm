/** Matching keys, normalized so the same person or company found twice gives the same key. No imports: any scope may use it. */
import type { CompanyInput, Ids, PersonInput, RecordType } from "./types.js";

/** A write mdm refuses because of what it was given; it never succeeds on a retry. */
export class MdmInputError extends Error {
  override name = "MdmInputError";
}
const bad = (message: string) => new MdmInputError(message);

/** ` Jane.Doe@example.com ` → `jane.doe@example.com`: trimmed and lowercase. */
export function email(value: string): string {
  const v = value.trim().toLowerCase().replace(/^mailto:/, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(v)) throw bad(`"${value}" is not an email address.`);
  return v;
}

/** `https://www.Acme.com/about` → `acme.com`: the host, lowercase, without `www.`, port or trailing dot. */
export function domain(value: string): string {
  const v = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/?#]*@/, "")
    .split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\d*\./, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(v)) throw bad(`"${value}" is not a domain.`);
  return v;
}

/**
 * A LinkedIn profile or page URL as `linkedin.com/in/<slug>` (people) or `linkedin.com/company/<slug>` (companies, also
 * `school` and `showcase` pages): any subdomain, scheme, query or trailing slash dropped, the slug lowercase.
 */
export function linkedin(value: string, type: RecordType): string {
  const m = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(in|company|school|showcase)\/([^/?#\s]+)/i.exec(value.trim());
  const kind = m?.[1].toLowerCase(), want = type === "person" ? kind === "in" : kind !== "in";
  if (!m || !want) throw bad(`"${value}" is not a LinkedIn ${type === "person" ? "profile (linkedin.com/in/…)" : "company page (linkedin.com/company/…)"}.`);
  let slug = m[2];
  try { slug = decodeURIComponent(slug); } catch {}
  return `linkedin.com/${kind}/${slug.toLowerCase()}`;
}

/** `{ hubspot: 123 }` → `[["id:hubspot", "123"]]`. */
function ids(given: Ids | undefined): [string, string][] {
  return Object.entries(given ?? {}).map(([system, id]) => {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(system)) throw bad(`"${system}" is not a system name (lowercase letters, digits, - and _).`);
    const v = String(id ?? "").trim();
    if (!v) throw bad(`The ${system} id is empty.`);
    return [`id:${system}`, v];
  });
}

const given = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** The keys a person or company input carries, strongest first: other systems' ids, then email or domain, then LinkedIn. */
export function keysOf(type: RecordType, input: PersonInput | CompanyInput): [string, string][] {
  const out = ids(input.ids);
  if (type === "person" && given((input as PersonInput).email)) out.push(["email", email((input as PersonInput).email!)]);
  if (type === "company" && given((input as CompanyInput).domain)) out.push(["domain", domain((input as CompanyInput).domain!)]);
  if (given(input.linkedin)) out.push(["linkedin", linkedin(input.linkedin, type)]);
  return out;
}

/** Field names `fields` may set: not the named attributes, which have their own inputs. */
const NAMED = new Set(["id", "type", "name", "title", "email", "domain", "linkedin", "company", "ids", "keys", "data"]);
export function fieldName(name: string): string {
  if (!/^[A-Za-z][\w.-]{0,63}$/.test(name)) throw bad(`"${name}" is not a field name (a letter, then letters, digits, _, . or -).`);
  if (NAMED.has(name)) throw bad(`"${name}" is set through its own input, not fields.`);
  return name;
}

/** A signal type: `job_change`, `funding_round`, … */
export function signalType(type: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(type ?? "")) throw bad(`"${type}" is not a signal type (lowercase, e.g. job_change).`);
  return type;
}
