import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const applicationMetadata = sqliteTable("application_metadata", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text().primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text().notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text().primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text(),
  password: text(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const workspaces = sqliteTable("workspaces", {
  id: text().primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text().notNull(),
  currentRevisionSequence: integer("current_revision_sequence")
    .notNull()
    .default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const workspaceRevisions = sqliteTable(
  "workspace_revisions",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revisionSequence: integer("revision_sequence").notNull(),
    manifestJson: text("manifest_json").notNull(),
    lockfileJson: text("lockfile_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    operationType: text("operation_type").notNull(),
    operationSkillId: text("operation_skill_id"),
    operationMetadataJson: text("operation_metadata_json").notNull(),
  },
  (table) => [
    uniqueIndex("workspace_revisions_workspace_sequence_unique").on(
      table.workspaceId,
      table.revisionSequence,
    ),
  ],
);

export const workspaceSkills = sqliteTable(
  "workspace_skills",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    source: text().notNull(),
    skillName: text("skill_name").notNull(),
    ref: text().notNull(),
    targetsJson: text("targets_json").notNull(),
    repository: text(),
    lockedRevision: text("locked_revision"),
    path: text(),
    contentHash: text("content_hash"),
    resolutionStatus: text("resolution_status").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_skills_workspace_skill_unique").on(
      table.workspaceId,
      table.skillId,
    ),
    uniqueIndex("workspace_skills_workspace_source_skill_unique").on(
      table.workspaceId,
      table.source,
      table.skillName,
    ),
  ],
);

export const idempotencyRecords = sqliteTable("idempotency_records", {
  key: text().primaryKey(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  operation: text().notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});
