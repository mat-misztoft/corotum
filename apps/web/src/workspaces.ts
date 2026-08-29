export type Workspace = { id: string; ownerUserId: string; name: string };

type D1Result<T> = { results?: T[] };
type Statement = {
  bind(...values: unknown[]): {
    first<T>(): Promise<T | null>;
    run(): Promise<unknown>;
    all<T>(): Promise<D1Result<T>>;
  };
};
export type WorkspaceDatabase = { prepare(query: string): Statement };

const defaultWorkspaceName = "My workspace";

function workspaceId() {
  return `ws_${crypto.randomUUID()}`;
}

/** Creates the sole v0.1 workspace idempotently, including concurrent OAuth callbacks. */
export async function ensureDefaultWorkspace(
  db: WorkspaceDatabase,
  userId: string,
): Promise<Workspace> {
  const existing = await db
    .prepare(
      "SELECT id, owner_user_id AS ownerUserId, name FROM workspaces WHERE owner_user_id = ?",
    )
    .bind(userId)
    .first<Workspace>();
  if (existing) return existing;

  const now = Date.now();
  const candidate = {
    id: workspaceId(),
    ownerUserId: userId,
    name: defaultWorkspaceName,
  };
  await db
    .prepare(
      "INSERT OR IGNORE INTO workspaces (id, owner_user_id, name, current_revision_sequence, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(candidate.id, candidate.ownerUserId, candidate.name, now, now)
    .run();

  const workspace = await db
    .prepare(
      "SELECT id, owner_user_id AS ownerUserId, name FROM workspaces WHERE owner_user_id = ?",
    )
    .bind(userId)
    .first<Workspace>();
  if (!workspace) throw new Error("Unable to create default workspace");
  return workspace;
}

/** Loads a workspace only when it belongs to the authenticated user. */
export async function requireWorkspaceAccess(
  db: WorkspaceDatabase,
  userId: string,
  workspaceId: string,
): Promise<Workspace> {
  const workspace = await db
    .prepare(
      "SELECT id, owner_user_id AS ownerUserId, name FROM workspaces WHERE id = ? AND owner_user_id = ?",
    )
    .bind(workspaceId, userId)
    .first<Workspace>();
  if (!workspace) throw new WorkspaceAccessError();
  return workspace;
}

export class WorkspaceAccessError extends Error {
  constructor() {
    super("Workspace not found");
    this.name = "WorkspaceAccessError";
  }
}

/** Confirms the device is an active member of the requested workspace. */
export async function requireDeviceWorkspaceAccess(
  db: WorkspaceDatabase,
  deviceId: string,
  workspaceId: string,
): Promise<void> {
  const membership = await db
    .prepare(
      "SELECT workspace_id AS workspaceId FROM device_workspaces WHERE device_id = ? AND workspace_id = ? AND is_active = 1",
    )
    .bind(deviceId, workspaceId)
    .first<{ workspaceId: string }>();
  if (!membership) throw new WorkspaceAccessError();
}
