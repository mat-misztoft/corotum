import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  type AgentAdapter,
  type AgentId,
  builtInAgentAdapters,
} from "../../../packages/agent-targets/src/index";
import {
  applicableAgentIds,
  type ManagedTarget,
  type TargetMode,
} from "../../../packages/agent-targets/src/targets";
import {
  type DesiredState,
  type RevisionId,
  type SkillId,
  skillId,
  type V2DesiredState,
  type V2LockedSkill,
} from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";

const targetModeSchema = z.enum(["symlink", "copy"]);
const targetSchema = z
  .object({
    agentId: z.string().min(1),
    mode: targetModeSchema,
    path: z.string().min(1),
    expectedHash: z.string().min(1),
  })
  .strict();
const skillStateSchema = z
  .object({
    name: z.string().min(1),
    canonicalPath: z.string().min(1),
    contentHash: z.string().min(1),
    ownership: z.enum(["verified", "recovered"]).default("verified"),
    targets: z.record(z.string(), targetSchema),
  })
  .strict();
const localStateSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    lastAppliedRevision: z.string().min(1).nullable(),
    skills: z.record(z.string(), skillStateSchema),
  })
  .strict();

export type LocalSkillState = Readonly<{
  name: string;
  canonicalPath: string;
  contentHash: string;
  ownership?: "verified" | "recovered";
  targets: Readonly<Record<string, LocalTargetState>>;
}>;

export type LocalTargetState = Readonly<{
  agentId: AgentId;
  mode: TargetMode;
  path: string;
  expectedHash: string;
}>;

export type LocalOperationalState = Readonly<{
  schemaVersion: 1 | 2;
  lastAppliedRevision: RevisionId | null;
  skills: Readonly<Record<SkillId, LocalSkillState>>;
}>;

/** Durable, local-only record of the assets Corotum owns. */
export class LocalOperationalStateStore {
  constructor(private readonly file: string) {}

  /** Returns null for absent or invalid state so callers can recover safely. */
  async load(): Promise<LocalOperationalState | null> {
    try {
      return toLocalOperationalState(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch {
      return null;
    }
  }

  async save(state: LocalOperationalState): Promise<void> {
    const normalized = toLocalOperationalState(state);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, this.file);
  }

  /**
   * An interrupted atomic save can retain exactly one valid temporary state.
   * It is ownership evidence only; ambiguity deliberately recovers nothing.
   */
  async loadRetainedRecoveryEvidence(): Promise<LocalOperationalState | null> {
    try {
      const prefix = `${basename(this.file)}.`;
      const files = (await readdir(dirname(this.file))).filter(
        (name) => name.startsWith(prefix) && name.endsWith(".tmp"),
      );
      const states = (
        await Promise.all(
          files.map(async (name) => {
            try {
              return toLocalOperationalState(
                JSON.parse(
                  await readFile(join(dirname(this.file), name), "utf8"),
                ),
              );
            } catch {
              return null;
            }
          }),
        )
      ).filter((state): state is LocalOperationalState => state !== null);
      return states.length === 1 ? states[0] : null;
    } catch {
      return null;
    }
  }
}

export type RecoverLocalOperationalStateInput = Readonly<{
  desired: DesiredState;
  lastAppliedRevision: RevisionId | null;
  skillsStoragePath: string;
  homeDir: string;
  enabledAgentIds: readonly AgentId[];
  /** A last known valid state can prove ownership of copy-fallback paths. */
  previousState?: LocalOperationalState | null;
}>;

/**
 * Recovers only assets whose Corotum ownership is provable: a locked,
 * hash-matching named canonical copy and target symlinks resolving to that
 * copy. A copy target is recoverable only when a retained prior state records
 * its path and expected hash. Equal-content regular directories are otherwise
 * deliberately left unmanaged.
 */
export async function recoverLocalOperationalState(
  input: RecoverLocalOperationalStateInput,
  adapters: readonly AgentAdapter[] = builtInAgentAdapters,
): Promise<LocalOperationalState> {
  const skills: Record<SkillId, LocalSkillState> = {} as Record<
    SkillId,
    LocalSkillState
  >;

  for (const locked of input.desired.lockfile.skills) {
    const canonicalPath = join(input.skillsStoragePath, locked.skill);
    if (!(await matchesHash(canonicalPath, locked.contentHash))) continue;

    const targets: Record<string, LocalTargetState> = {};
    for (const agentId of applicableAgentIds(
      input.desired.manifest.skills.find((skill) => skill.id === locked.id)
        ?.targets ?? [],
      input.enabledAgentIds,
    )) {
      const adapter = adapters.find((candidate) => candidate.id === agentId);
      if (!adapter) continue;
      for (const parent of adapter.globalSkillPaths(input.homeDir)) {
        const path = join(parent, locked.skill);
        if (await isSymlinkTo(path, canonicalPath)) {
          targets[targetKey(agentId, path)] = {
            agentId,
            mode: "symlink",
            path,
            expectedHash: locked.contentHash,
          };
          continue;
        }
        const previous =
          input.previousState?.skills[locked.id]?.targets[
            targetKey(agentId, path)
          ];
        if (
          previous?.mode === "copy" &&
          previous.path === path &&
          previous.expectedHash === locked.contentHash &&
          (await matchesHash(path, locked.contentHash))
        ) {
          targets[targetKey(agentId, path)] = {
            agentId,
            mode: "copy",
            path,
            expectedHash: locked.contentHash,
          };
        }
      }
    }

    skills[locked.id] = {
      name: locked.skill,
      canonicalPath,
      contentHash: locked.contentHash,
      ownership: "recovered",
      targets,
    };
  }

  return {
    schemaVersion: 2,
    lastAppliedRevision: input.lastAppliedRevision,
    skills,
  };
}

export type RecoverV2LocalOperationalStateInput = Readonly<{
  desired: V2DesiredState;
  lastAppliedRevision: RevisionId | null;
  skillsStoragePath: string;
  homeDir: string;
  enabledAgentIds: readonly AgentId[];
  previousState?: LocalOperationalState | null;
}>;

/** Recovers only named canonical copies and targets whose v2 lock hash matches. */
export async function recoverV2LocalOperationalState(
  input: RecoverV2LocalOperationalStateInput,
  adapters: readonly AgentAdapter[] = builtInAgentAdapters,
): Promise<LocalOperationalState> {
  const skills: Record<SkillId, LocalSkillState> = {} as Record<
    SkillId,
    LocalSkillState
  >;

  for (const locked of input.desired.lockfile.skills) {
    const expected = expectedV2Hash(locked);
    const canonicalPath = join(input.skillsStoragePath, locked.name);
    if (!(await matchesNormalizedHash(canonicalPath, expected))) continue;

    const targets: Record<string, LocalTargetState> = {};
    for (const agentId of applicableAgentIds(
      input.desired.manifest.skills.find((skill) => skill.id === locked.id)
        ?.targets ?? [],
      input.enabledAgentIds,
    )) {
      const adapter = adapters.find((candidate) => candidate.id === agentId);
      if (!adapter) continue;
      for (const parent of adapter.globalSkillPaths(input.homeDir)) {
        const path = join(parent, locked.name);
        if (await isSymlinkTo(path, canonicalPath)) {
          targets[targetKey(agentId, path)] = {
            agentId,
            mode: "symlink",
            path,
            expectedHash: expected,
          };
          continue;
        }
        const previous =
          input.previousState?.skills[locked.id]?.targets[
            targetKey(agentId, path)
          ];
        if (
          previous?.mode === "copy" &&
          previous.path === path &&
          previous.expectedHash === expected &&
          (await matchesNormalizedHash(path, expected))
        ) {
          targets[targetKey(agentId, path)] = {
            agentId,
            mode: "copy",
            path,
            expectedHash: expected,
          };
        }
      }
    }

    skills[locked.id] = {
      name: locked.name,
      canonicalPath,
      contentHash: expected,
      ownership: "recovered",
      targets,
    };
  }

  return {
    schemaVersion: 2,
    lastAppliedRevision: input.lastAppliedRevision,
    skills,
  };
}

export function expectedV2Hash(lock: V2LockedSkill): `sha256:${string}` {
  return lock.materialization.kind === "source"
    ? lock.materialization.contentHash
    : lock.materialization.artifact.contentHash;
}

/** Converts persisted target records to the target manager's ownership model. */
export function managedTargetsFromState(
  state: LocalOperationalState,
): readonly ManagedTarget[] {
  return Object.entries(state.skills)
    .flatMap(([id, skill]) =>
      Object.values(skill.targets).map((target) => ({
        skillId: skillId(id),
        agentId: target.agentId,
        path: target.path,
        canonicalPath: skill.canonicalPath,
        mode: target.mode,
        expectedHash: target.expectedHash,
      })),
    )
    .sort((left, right) =>
      `${left.skillId}\0${left.agentId}\0${left.path}`.localeCompare(
        `${right.skillId}\0${right.agentId}\0${right.path}`,
      ),
    );
}

function toLocalOperationalState(input: unknown): LocalOperationalState {
  const parsed = localStateSchema.parse(input);
  const skills: Record<SkillId, LocalSkillState> = {} as Record<
    SkillId,
    LocalSkillState
  >;

  for (const [id, skill] of Object.entries(parsed.skills)) {
    const parsedId = skillId(id);
    const targets: Record<string, LocalTargetState> = {};
    for (const [key, target] of Object.entries(skill.targets)) {
      if (!isAgentId(target.agentId))
        throw new Error("Invalid stored agent ID.");
      targets[key] = { ...target, agentId: target.agentId };
    }
    skills[parsedId] = { ...skill, ownership: skill.ownership, targets };
  }

  return {
    schemaVersion: 2,
    lastAppliedRevision: parsed.lastAppliedRevision as RevisionId | null,
    skills,
  };
}

function isAgentId(value: string): value is AgentId {
  return builtInAgentAdapters.some((agent) => agent.id === value);
}

function targetKey(agentId: AgentId, path: string): string {
  return `${agentId}\0${path}`;
}

async function matchesHash(
  path: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    return (await hashSkillDirectory(path)) === expectedHash;
  } catch {
    return false;
  }
}

async function matchesNormalizedHash(
  path: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    return (await scanNormalizedContent(path)).contentHash === expectedHash;
  } catch {
    return false;
  }
}

async function isSymlinkTo(
  path: string,
  expectedTarget: string,
): Promise<boolean> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    return (await realpath(path)) === (await realpath(expectedTarget));
  } catch {
    return false;
  }
}
