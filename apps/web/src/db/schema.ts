import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const applicationMetadata = sqliteTable("application_metadata", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
