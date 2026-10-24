/**
 * The mdm contract: its records as company code and other plugins see them, and the `mdm` slot (MdmSlotV1). Types only.
 */

/** The record types mdm holds. A later type (a job posting, say) joins this union and keeps the same keys, fields and signals. */
export type RecordType = "person" | "company";
/** A record by its type and id; any record mdm returns is one. */
export type Ref = { type: RecordType; id: string };

/** A matching key: `email`, `domain`, `linkedin` or `id:<system>` (an id in another system), normalized. */
export type Key = { key: string; value: string; source: string; since: string };

type Base = {
  id: string;
  /** Enriched fields beyond the named ones, as set through `fields`. */
  data: Record<string, unknown>;
  keys: Key[];
  createdAt: string;
  updatedAt: string;
};
export type Company = Base & { type: "company"; name: string | null; domain: string | null; linkedin: string | null };
export type Person = Base & {
  type: "person"; name: string | null; email: string | null; linkedin: string | null; title: string | null;
  /** The company the person works at now. */
  companyId: string | null;
};
export type Signal = {
  id: string; type: string; about: Ref; key: string; occurredAt: string; source: string; data: Record<string, unknown>;
  workflow: string | null; runId: string | null; createdAt: string;
};
/** What an upsert returns: the one record, whether it is new, and other records some of the given keys already belong to. */
export type Upserted<T> = T & { created: boolean; conflicts: string[] };

/** Ids in other systems (a CRM, a vendor): system name → id. */
export type Ids = Record<string, string | number>;
export type CompanyInput = {
  id?: string; domain?: string | null; linkedin?: string | null; ids?: Ids; name?: string | null;
  /** Enriched fields: name → value. A null value records "looked, nothing found", so the field counts as known. */
  fields?: Record<string, unknown>;
};
export type PersonInput = {
  id?: string; email?: string | null; linkedin?: string | null; ids?: Ids; name?: string | null; title?: string | null;
  /** Where the person works now: a company record, or the company's keys to match or create it. */
  company?: Ref | CompanyInput | null;
  fields?: Record<string, unknown>;
};
export type SignalInput = {
  /** The person or company the signal is about. */
  about: Ref;
  /** What happened, e.g. `job_change`, `job_posting`, `funding_round`, `site_visit`. */
  type: string;
  /** When it happened (ISO time or Date); defaults to now. */
  at?: string | Date;
  /** What makes it the same signal when found again, e.g. the posting's URL or the vendor's event id; defaults to `at`. */
  key?: string;
  data?: Record<string, unknown>;
};
/** Where a write came from: `source` names the workflow or vendor; the step fills in the run. */
export type Origin = { source: string; workflow?: string | null; runId?: string | null };
/** A known field: its value, who set it and when. */
export type Known = { value: unknown; source: string; workflow: string | null; runId: string | null; setAt: string };

export interface MdmSlotV1 {
  upsertCompany(input: CompanyInput, origin: Origin): Promise<Upserted<Company>>;
  upsertPerson(input: PersonInput, origin: Origin): Promise<Upserted<Person>>;
  upsertSignal(input: SignalInput, origin: Origin): Promise<Signal & { created: boolean }>;
  /** By id (a merged id finds the record it was merged into) or by any of its keys; null when none matches. */
  findCompany(by: Omit<CompanyInput, "name" | "fields">): Promise<Company | null>;
  findPerson(by: Omit<PersonInput, "name" | "title" | "company" | "fields">): Promise<Person | null>;
  /** Folds `drop` into `keep` (same type): keys, fields, signals and links move; `keep`'s values win; `drop`'s id then finds `keep`. */
  merge(keep: Ref, drop: Ref): Promise<Person | Company>;
  /** Every known field of a record, or only `fields`; its keys count too (`email`, `domain`, `linkedin`, `id:<system>`). */
  known(ref: Ref, fields?: string[]): Promise<Record<string, Known>>;
  /** Which of `fields` are unknown, or were set more than `maxAgeDays` ago (when given). */
  stale(ref: Ref, fields: string[], opts?: { maxAgeDays?: number }): Promise<string[]>;
  signals(ref: Ref, opts?: { type?: string; limit?: number }): Promise<Signal[]>;
}
