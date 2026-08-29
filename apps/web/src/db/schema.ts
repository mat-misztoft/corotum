import { sql } from "drizzle-orm";
import {
  check,
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

export const devices = sqliteTable("devices", {
  id: text().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text().notNull(),
  platform: text().notNull(),
  architecture: text().notNull(),
  cliVersion: text("cli_version").notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

/** Future-ready memberships; v0.1 permits one active workspace per device. */
export const deviceWorkspaces = sqliteTable(
  "device_workspaces",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    appliedRevisionSequence: integer("applied_revision_sequence")
      .notNull()
      .default(0),
    syncStatus: text("sync_status").notNull().default("NEVER_SYNCED"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp" }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
  },
  (table) => [
    uniqueIndex("device_workspaces_device_workspace_unique").on(
      table.deviceId,
      table.workspaceId,
    ),
    uniqueIndex("device_workspaces_one_active_workspace_unique")
      .on(table.deviceId)
      .where(sql`${table.isActive} = 1`),
  ],
);

export const deviceAgents = sqliteTable(
  "device_agents",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    status: text().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("device_agents_device_agent_unique").on(
      table.deviceId,
      table.agentId,
    ),
    check(
      "device_agents_agent_id_check",
      sql`${table.agentId} IN ('codex', 'claude-code', 'pi', 'gemini-cli', 'opencode', 'cursor', 'windsurf', 'cline', 'roo-code', 'github-copilot', 'kiro-cli')`,
    ),
    check(
      "device_agents_status_check",
      sql`${table.status} IN ('DETECTED', 'ENABLED', 'DISABLED')`,
    ),
  ],
);

export const cliPairings = sqliteTable(
  "cli_pairings",
  {
    id: text().primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    userCode: text("user_code").notNull().unique(),
    status: text().notNull().default("PENDING"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "cascade",
    }),
    deviceName: text("device_name").notNull(),
    platform: text().notNull(),
    architecture: text().notNull(),
    cliVersion: text("cli_version").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    check(
      "cli_pairings_status_check",
      sql`${table.status} IN ('PENDING', 'APPROVED', 'EXPIRED', 'CONSUMED')`,
    ),
  ],
);

export const deviceTokens = sqliteTable("device_tokens", {
  id: text().primaryKey(),
  deviceId: text("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const idempotencyRecords = sqliteTable("idempotency_records", {
  key: text().primaryKey(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  operation: text().notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});
