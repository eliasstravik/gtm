import * as weeklyNewCompaniesPg from "drizzle-orm/pg-core";

/** One row per week: how many companies were saved in it (recipe weekly-new-companies). */
export const weeklyNewCompanies = weeklyNewCompaniesPg.pgTable("weekly_new_companies", {
  weekStart: weeklyNewCompaniesPg.date("week_start").primaryKey(),
  companies: weeklyNewCompaniesPg.integer("companies").notNull(),
  countedAt: weeklyNewCompaniesPg.timestamp("counted_at", { withTimezone: true }).notNull().defaultNow(),
});
