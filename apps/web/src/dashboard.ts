import { type DesiredState, type RevisionTransition, skillId, type V2DesiredState } from "../../../packages/core/src/index";
import { requireHostedCloudAccess } from "./billing";
import { isV2CloudState, loadCurrentDesiredState, mutateDesiredState, type CloudDesiredState, type CloudRevision } from "./revisions";
import { ensureDefaultWorkspace, type WorkspaceDatabase } from "./workspaces";

type DashboardDatabase = WorkspaceDatabase & {
  batch: Parameters<typeof mutateDesiredState>[0]["batch"];
};

type DeviceRow = Readonly<{
  id: string;
  name: string;
  platform: string;
  architecture: string;
  cliVersion: string;
  appliedRevisionSequence: number;
  syncStatus: string;
  lastSyncAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}>;

type TargetRow = Readonly<{
  deviceId: string;
  skillId: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  contentHash: string | null;
  updatedAt: number;
}>;

export const DASHBOARD_SKILL_MATERIALIZATIONS = [
  "source-backed",
  "artifact-backed-with-provenance",
  "artifact-backed-without-source",
  "pending-resolution",
] as const;

export type DashboardSkillMaterialization = (typeof DASHBOARD_SKILL_MATERIALIZATIONS)[number];

/** Semantic skill row for dashboard/WebMCP. Locators, bytes and local paths stay off this contract. */
export type DashboardSkill = Readonly<{
  id: string;
  skill: string;
  ref: string;
  targets: CloudDesiredState["manifest"]["skills"][number]["targets"];
  resolutionStatus: string;
  locked: boolean;
  materialization: DashboardSkillMaterialization;
}>;

export type DashboardView = Readonly<{
  workspace: { id: string; name: string };
  revision: { id: string | null; sequence: number };
  skills: readonly DashboardSkill[];
  devices: readonly (DeviceRow & { targets: readonly TargetRow[] })[];
}>;

function sanitizeReportedText(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[/\\]/.test(trimmed) || /token|secret|password|\.corotumignore|credentials/i.test(trimmed)) {
    return "A local target failed.";
  }
  return trimmed.slice(0, 200);
}

function v2Materialization(
  skill: V2DesiredState["manifest"]["skills"][number],
  lock: V2DesiredState["lockfile"]["skills"][number] | undefined,
): DashboardSkillMaterialization {
  if (skill.resolutionStatus === "PENDING_RESOLUTION" || !lock) return "pending-resolution";
  if (lock.materialization.kind === "source") return "source-backed";
  return skill.source ? "artifact-backed-with-provenance" : "artifact-backed-without-source";
}

/** Projects D1 desired state into dashboard fields; never copies lock locators or source paths. */
export function projectDashboardSkills(state: CloudDesiredState): readonly DashboardSkill[] {
  if (isV2CloudState(state)) {
    return state.manifest.skills.map((skill) => {
      const lock = state.lockfile.skills.find((candidate) => candidate.id === skill.id);
      return {
        id: skill.id,
        skill: skill.name,
        ref: skill.source?.ref ?? "",
        targets: skill.targets,
        resolutionStatus: skill.resolutionStatus,
        locked: Boolean(lock),
        materialization: v2Materialization(skill, lock),
      };
    });
  }
  return state.manifest.skills.map((skill) => {
    const lock = state.lockfile.skills.find((candidate) => candidate.id === skill.id);
    const pending = skill.resolutionStatus === "PENDING_RESOLUTION" || !lock;
    return {
      id: skill.id,
      skill: skill.skill,
      ref: skill.ref,
      targets: skill.targets,
      resolutionStatus: skill.resolutionStatus,
      locked: Boolean(lock),
      materialization: pending ? "pending-resolution" : "source-backed",
    };
  });
}

/** Read model shared by dashboard and future WebMCP entry points. */
export async function readDashboard(
  db: DashboardDatabase,
  userId: string,
): Promise<DashboardView> {
  const workspace = await ensureDefaultWorkspace(db, userId);
  const current = await loadCurrentDesiredState(db, userId, workspace.id);
  const deviceRows = await db
    .prepare(
      `SELECT d.id, d.name, d.platform, d.architecture, d.cli_version AS cliVersion,
              dw.applied_revision_sequence AS appliedRevisionSequence, dw.sync_status AS syncStatus,
              dw.last_sync_at AS lastSyncAt, dw.last_error_code AS lastErrorCode,
              dw.last_error_message AS lastErrorMessage
       FROM devices d JOIN device_workspaces dw ON dw.device_id = d.id AND dw.is_active = 1
       WHERE d.user_id = ? AND dw.workspace_id = ? AND d.revoked_at IS NULL ORDER BY d.name`,
    )
    .bind(userId, workspace.id)
    .all<DeviceRow>();
  const targets = await db
    .prepare(
      `SELECT device_id AS deviceId, skill_id AS skillId, agent_id AS agentId, status,
              error_code AS errorCode, error_message AS errorMessage, content_hash AS contentHash,
              updated_at AS updatedAt FROM device_skill_targets WHERE workspace_id = ?
       ORDER BY skill_id, agent_id`,
    )
    .bind(workspace.id)
    .all<TargetRow>();
  const targetRows = (targets.results ?? []).map((target) => ({
    ...target,
    errorCode: sanitizeReportedText(target.errorCode),
    errorMessage: sanitizeReportedText(target.errorMessage),
  }));
  return {
    workspace,
    revision: { id: current.id, sequence: current.sequence },
    skills: projectDashboardSkills(current.state),
    // syncStatus/appliedRevisionSequence are device reports, never inferred from desired state.
    devices: (deviceRows.results ?? []).map((device) => ({
      ...device,
      lastErrorCode: sanitizeReportedText(device.lastErrorCode),
      lastErrorMessage: sanitizeReportedText(device.lastErrorMessage),
      targets: targetRows.filter((target) => target.deviceId === device.id),
    })),
  };
}

export type DashboardMutation =
  | { type: "ADD"; source: string; skill: string; ref?: string; targets?: "all" | string[] }
  | { type: "REMOVE"; skillId: string }
  | { type: "UPDATE"; skillId: string }
  | { type: "SET_REF"; skillId: string; ref: string };

/** Stable mutation response shared by dashboard/API and WebMCP callers. */
export function dashboardMutationResult(revision: CloudRevision) {
  return {
    revisionId: revision.id,
    revisionSequence: revision.sequence,
    pendingResolution: revision.state.manifest.skills
      .filter((skill) => skill.resolutionStatus === "PENDING_RESOLUTION")
      .map((skill) => skill.id),
  };
}

function rejectCredentialUrl(source: string) {
  try {
    const url = new URL(source);
    if (url.username || url.password) throw new Error("Repository must not include credentials");
  } catch (error) {
    if (error instanceof Error && error.message === "Repository must not include credentials") throw error;
  }
}

/** Dashboard mutations change desired state only; devices sync only when they report it. */
export async function mutateDashboard(
  db: DashboardDatabase,
  input: Readonly<{
    userId: string;
    hosted: boolean;
    baseRevisionId: string | null;
    idempotencyKey: string;
    mutation: DashboardMutation;
  }>,
): Promise<CloudRevision> {
  await requireHostedCloudAccess(db, input.userId, input.hosted);
  const workspace = await ensureDefaultWorkspace(db, input.userId);
  const current = await loadCurrentDesiredState(db, input.userId, workspace.id);
  if (current.id !== input.baseRevisionId) throw new Error("BASE_REVISION_CONFLICT");
  // The current dashboard form only supplies v1 source fields.
  if (isV2CloudState(current.state)) throw new Error("V2_DASHBOARD_MUTATION_UNSUPPORTED");
  let skills = [...current.state.manifest.skills];
  let locks = [...current.state.lockfile.skills];
  let transition: RevisionTransition;
  if (input.mutation.type === "ADD") {
    rejectCredentialUrl(input.mutation.source);
    const source = input.mutation.source.trim();
    const name = input.mutation.skill.trim();
    if (!source || !name || skills.some((item) => item.source === source && item.skill === name)) throw new Error("INVALID_SKILL");
    const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
    skills = [...skills, { id, source, skill: name, ref: input.mutation.ref?.trim() || "HEAD", targets: input.mutation.targets ?? "all", resolutionStatus: "PENDING_RESOLUTION" }];
    transition = { type: "ADD", skillId: id, metadata: { resolution: "pending" } };
  } else {
    const mutation = input.mutation;
    const target = skills.find((item) => item.id === mutation.skillId);
    if (!target) throw new Error("SKILL_NOT_FOUND");
    if (mutation.type === "REMOVE") {
      skills = skills.filter((item) => item.id !== target.id);
      locks = locks.filter((item) => item.id !== target.id);
      transition = { type: "REMOVE", skillId: target.id, metadata: {} };
    } else {
      const ref = mutation.type === "SET_REF" ? mutation.ref.trim() : target.ref;
      if (!ref) throw new Error("INVALID_REF");
      skills = skills.map((item) => item.id === target.id ? { ...item, ref, resolutionStatus: "PENDING_RESOLUTION" as const } : item);
      locks = locks.filter((item) => item.id !== target.id);
      transition = { type: mutation.type, skillId: target.id, metadata: { resolution: "pending" } };
    }
  }
  const state: DesiredState = { manifest: { version: 1, skills }, lockfile: { version: 1, skills: locks } };
  return mutateDesiredState(db as never, {
    workspaceId: workspace.id, userId: input.userId, baseRevisionId: input.baseRevisionId,
    idempotencyKey: input.idempotencyKey, actor: { type: "user", id: input.userId }, state, transition,
  });
}
