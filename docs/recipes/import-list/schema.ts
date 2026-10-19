import * as importListPg from "drizzle-orm/pg-core";

/** Companies saved from supplied lists, one row per domain (recipe import-list). */
export const companies = importListPg.pgTable("companies", {
  id: importListPg.serial("id").primaryKey(),
  name: importListPg.text("name").notNull(),
  domain: importListPg.text("domain").notNull().unique(),
  source: importListPg.text("source"),
  savedAt: importListPg.timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
});
