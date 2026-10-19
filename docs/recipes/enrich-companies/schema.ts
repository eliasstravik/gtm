import * as enrichCompaniesPg from "drizzle-orm/pg-core";

/** One profile per company domain, read from its website by an AI step (recipe enrich-companies). */
export const companyProfiles = enrichCompaniesPg.pgTable("company_profiles", {
  domain: enrichCompaniesPg.text("domain").primaryKey(),
  description: enrichCompaniesPg.text("description"),
  industry: enrichCompaniesPg.text("industry"),
  businessType: enrichCompaniesPg.text("business_type"),
  location: enrichCompaniesPg.text("location"),
  costUsd: enrichCompaniesPg.doublePrecision("cost_usd").notNull().default(0),
  enrichedAt: enrichCompaniesPg.timestamp("enriched_at", { withTimezone: true }).notNull().defaultNow(),
});
