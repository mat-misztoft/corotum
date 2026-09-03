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

export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    issuer: text().notNull(),
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
    displayLabel: text("display_label"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_account_id_unique").on(
      table.issuer,
      table.accountId,
    ),
  ],
);

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
    /** v2 durable REMOVE/UNMANAGE ledger; v1 rows contain an empty v2 ledger. */
    dispositionLedgerJson: text("disposition_ledger_json")
      .notNull()
      .default('{"version":2,"activeDispositions":{}}'),
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
    /** v2 artifact-backed skills intentionally have no source provenance. */
    source: text(),
    skillName: text("skill_name").notNull(),
    ref: text(),
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
    uniqueIndex("workspace_skills_workspace_normalized_name_unique").on(
      table.workspaceId,
      sql`lower(skill_name)`,
    ),
  ],
);

/** Immutable metadata only; archive bytes live in workspace-scoped R2. */
export const workspaceArtifacts = sqliteTable(
  "workspace_artifacts",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    integrityHash: text("integrity_hash").notNull(),
    kind: text().notNull(),
    contentHash: text("content_hash").notNull(),
    locator: text().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_artifacts_workspace_skill_integrity_unique").on(
      table.workspaceId,
      table.skillId,
      table.integrityHash,
    ),
  ],
);

/** Snapshot references make current/previous artifact retention candidates queryable. */
export const workspaceRevisionArtifacts = sqliteTable(
  "workspace_revision_artifacts",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => workspaceRevisions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    integrityHash: text("integrity_hash").notNull(),
  },
  (table) => [
    uniqueIndex("workspace_revision_artifacts_unique").on(
      table.revisionId,
      table.skillId,
      table.integrityHash,
    ),
    uniqueIndex("workspace_revision_artifacts_lookup_unique").on(
      table.workspaceId,
      table.revisionId,
      table.skillId,
      table.integrityHash,
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

/** Current per-device/skill/agent outcome. Dashboard reads these rows, never a devices JSON blob. */
export const deviceSkillTargets = sqliteTable(
  "device_skill_targets",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    agentId: text("agent_id").notNull(),
    status: text().notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    contentHash: text("content_hash"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("device_skill_targets_unique").on(
      table.deviceId,
      table.workspaceId,
      table.skillId,
      table.agentId,
    ),
    check(
      "device_skill_targets_agent_id_check",
      sql`${table.agentId} IN ('codex', 'claude-code', 'pi', 'gemini-cli', 'opencode', 'cursor', 'windsurf', 'cline', 'roo-code', 'github-copilot', 'kiro-cli')`,
    ),
    check(
      "device_skill_targets_status_check",
      sql`${table.status} IN ('SYNCED', 'DRIFTED', 'AUTH_REQUIRED', 'ERROR')`,
    ),
  ],
);

/** Last device-performed upstream check for each desired skill. */
export const deviceSkillUpdates = sqliteTable(
  "device_skill_updates",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    status: text().notNull(),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("device_skill_updates_unique").on(
      table.deviceId,
      table.workspaceId,
      table.skillId,
    ),
    check(
      "device_skill_updates_status_check",
      sql`${table.status} IN ('UP_TO_DATE', 'UPDATE_AVAILABLE', 'UNKNOWN', 'AUTH_REQUIRED', 'CHECK_FAILED')`,
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

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    billingInterval: text("billing_interval").notNull(),
    status: text().notNull(),
    currentPeriodStart: integer("current_period_start", {
      mode: "timestamp",
    }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_provider_subscription_unique").on(
      table.provider,
      table.providerSubscriptionId,
    ),
    check(
      "subscriptions_billing_interval_check",
      sql`${table.billingInterval} IN ('month', 'year')`,
    ),
  ],
);

export const billingEvents = sqliteTable(
  "billing_events",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: integer("processed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("billing_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
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

/** Operational throttle state; not a domain entity. */
export const rateLimitWindows = sqliteTable("rate_limit_windows", {
  key: text().primaryKey(),
  count: integer().notNull(),
  windowStart: integer("window_start").notNull(),
});
