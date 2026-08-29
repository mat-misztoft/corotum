import {
  type DesiredState,
  type RevisionTransition,
  serializeRevisionTransition,
  validateDesiredState,
} from "../../../packages/core/src/index";
import { requireWorkspaceAccess, type WorkspaceDatabase } from "./workspaces";

export type RevisionActor = Readonly<{
  type: "user" | "device" | "system";
  id: string;
}>;

export type DesiredStateMutation = Readonly<{
  workspaceId: string;
  userId: string;
  baseRevisionId: string | null;
  idempotencyKey: string;
  actor: RevisionActor;
  state: DesiredState;
  transition: RevisionTransition;
}>;

export type CloudRevision = Readonly<{
  id: string;
  sequence: number;
  state: DesiredState;
}>;

export class RevisionConflictError extends Error {
  constructor() {
    super("The workspace changed before this mutation could be applied.");
    this.name = "RevisionConflictError";
  }
}

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("An idempotency key is required for a desired-state mutation.");
    this.name = "InvalidIdempotencyKeyError";
  }
}

type RunResult = { meta?: { changes?: number } };
type BoundStatement = ReturnType<
  ReturnType<WorkspaceDatabase["prepare"]>["bind"]
>;
type RevisionDatabase = WorkspaceDatabase & {
  batch(statements: readonly BoundStatement[]): Promise<readonly RunResult[]>;
};

function revisionId() {
  return `rev_${crypto.randomUUID()}`;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

export const emptyDesiredState: DesiredState = {
  manifest: { version: 1, skills: [] },
  lockfile: { version: 1, skills: [] },
};

function materializedSkillStatements(
  db: RevisionDatabase,
  workspaceId: string,
  revision: CloudRevision,
  now: number,
): BoundStatement[] {
  return revision.state.manifest.skills.map((skill) => {
    const lock = revision.state.lockfile.skills.find(
      (candidate) => candidate.id === skill.id,
    );
    return db
      .prepare(
        `INSERT INTO workspace_skills
          (workspace_id, skill_id, source, skill_name, ref, targets_json, repository, locked_revision, path, content_hash, resolution_status, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM workspace_revisions WHERE id = ? AND workspace_id = ?)`,
      )
      .bind(
        workspaceId,
        skill.id,
        skill.source,
        skill.skill,
        skill.ref,
        serialize(skill.targets),
        lock?.repository ?? null,
        lock?.revision ?? null,
        lock?.path ?? null,
        lock?.contentHash ?? null,
        skill.resolutionStatus,
        now,
        revision.id,
        workspaceId,
      );
  });
}

/**
 * Writes a Cloud desired-state revision. The revision insert is a conditional
 * compare-and-swap; every subsequent statement is gated on that insert, so a
 * stale caller cannot alter the materialized view or workspace pointer.
 */
export async function mutateDesiredState(
  db: RevisionDatabase,
  input: DesiredStateMutation,
): Promise<CloudRevision> {
  if (!input.idempotencyKey.trim()) throw new InvalidIdempotencyKeyError();
  await requireWorkspaceAccess(db, input.userId, input.workspaceId);

  const prior = await db
    .prepare(
      "SELECT response_json AS responseJson FROM idempotency_records WHERE key = ? AND actor_id = ? AND operation = 'desired_state_mutation'",
    )
    .bind(input.idempotencyKey, input.actor.id)
    .first<{ responseJson: string }>();
  if (prior) return JSON.parse(prior.responseJson) as CloudRevision;

  const state = validateDesiredState(input.state, "cloud");
  const workspace = await db
    .prepare(
      "SELECT current_revision_sequence AS currentRevisionSequence FROM workspaces WHERE id = ? AND owner_user_id = ?",
    )
    .bind(input.workspaceId, input.userId)
    .first<{ currentRevisionSequence: number }>();
  if (!workspace) throw new RevisionConflictError();

  const now = Date.now();
  const revision: CloudRevision = {
    id: revisionId(),
    sequence: workspace.currentRevisionSequence + 1,
    state,
  };
  const responseJson = serialize(revision);
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const baseMatches = input.baseRevisionId
    ? "EXISTS (SELECT 1 FROM workspace_revisions WHERE id = ? AND workspace_id = w.id AND revision_sequence = w.current_revision_sequence)"
    : "w.current_revision_sequence = 0";
  const baseParameters = input.baseRevisionId ? [input.baseRevisionId] : [];

  const statements: BoundStatement[] = [
    db
      .prepare(
        `INSERT INTO idempotency_records (key, actor_type, actor_id, operation, response_json, created_at, expires_at)
         SELECT ?, ?, ?, 'desired_state_mutation', ?, ?, ?
         FROM workspaces w
         WHERE w.id = ? AND w.owner_user_id = ? AND ${baseMatches}`,
      )
      .bind(
        input.idempotencyKey,
        input.actor.type,
        input.actor.id,
        responseJson,
        now,
        expiresAt,
        input.workspaceId,
        input.userId,
        ...baseParameters,
      ),
    db
      .prepare(
        `INSERT INTO workspace_revisions
          (id, workspace_id, revision_sequence, manifest_json, lockfile_json, created_at, created_by_type, created_by_id, operation_type, operation_skill_id, operation_metadata_json)
         SELECT ?, w.id, w.current_revision_sequence + 1, ?, ?, ?, ?, ?, ?, ?, ?
         FROM workspaces w
         WHERE w.id = ? AND w.owner_user_id = ? AND ${baseMatches}`,
      )
      .bind(
        revision.id,
        serialize(state.manifest),
        serialize(state.lockfile),
        now,
        input.actor.type,
        input.actor.id,
        input.transition.type,
        input.transition.skillId,
        serializeRevisionTransition(input.transition),
        input.workspaceId,
        input.userId,
        ...baseParameters,
      ),
    db
      .prepare(
        "DELETE FROM workspace_skills WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM workspace_revisions WHERE id = ? AND workspace_id = ?)",
      )
      .bind(input.workspaceId, revision.id, input.workspaceId),
    ...materializedSkillStatements(db, input.workspaceId, revision, now),
    db
      .prepare(
        "UPDATE workspaces SET current_revision_sequence = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND EXISTS (SELECT 1 FROM workspace_revisions WHERE id = ? AND workspace_id = ?)",
      )
      .bind(
        revision.sequence,
        now,
        input.workspaceId,
        input.userId,
        revision.id,
        input.workspaceId,
      ),
  ];

  try {
    const results = await db.batch(statements);
    if ((results[1]?.meta?.changes ?? 0) === 0)
      throw new RevisionConflictError();
  } catch (error) {
    // A simultaneous retry may have won the idempotency-key unique constraint.
    const existing = await db
      .prepare(
        "SELECT response_json AS responseJson FROM idempotency_records WHERE key = ? AND actor_id = ? AND operation = 'desired_state_mutation'",
      )
      .bind(input.idempotencyKey, input.actor.id)
      .first<{ responseJson: string }>();
    if (existing) return JSON.parse(existing.responseJson) as CloudRevision;
    throw error;
  }

  return revision;
}

/** Reads the authoritative current snapshot, or an empty state before the first revision. */
export async function loadCurrentDesiredState(
  db: WorkspaceDatabase,
  userId: string,
  workspaceId: string,
): Promise<
  CloudRevision | { id: null; sequence: number; state: DesiredState }
> {
  await requireWorkspaceAccess(db, userId, workspaceId);
  const row = await db
    .prepare(
      `SELECT w.current_revision_sequence AS sequence,
              wr.id AS id,
              wr.manifest_json AS manifestJson,
              wr.lockfile_json AS lockfileJson
       FROM workspaces w
       LEFT JOIN workspace_revisions wr
         ON wr.workspace_id = w.id
        AND wr.revision_sequence = w.current_revision_sequence
       WHERE w.id = ? AND w.owner_user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<{
      sequence: number;
      id: string | null;
      manifestJson: string | null;
      lockfileJson: string | null;
    }>();
  if (!row) throw new RevisionConflictError();
  if (!row.id || row.manifestJson === null || row.lockfileJson === null) {
    return { id: null, sequence: row.sequence, state: emptyDesiredState };
  }
  return {
    id: row.id,
    sequence: row.sequence,
    state: validateDesiredState(
      {
        manifest: JSON.parse(row.manifestJson),
        lockfile: JSON.parse(row.lockfileJson),
      },
      "cloud",
    ),
  };
}
