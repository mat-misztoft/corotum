import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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
} from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";

const targetModeSchema = z.enum(["symlink", "copy"]);
const targetSchema = z
  .object({
    agentId: z.string().min(1),
    mode: targetModeSchema,
    path: z.string().min(1),
  })
  .strict();
const skillStateSchema = z
  .object({
    canonicalPath: z.string().min(1),
    contentHash: z.string().min(1),
    targets: z.record(z.string(), targetSchema),
  })
  .strict();
const localStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastAppliedRevision: z.string().min(1).nullable(),
    skills: z.record(z.string(), skillStateSchema),
  })
  .strict();

export type LocalSkillState = Readonly<{
  canonicalPath: string;
  contentHash: string;
  targets: Readonly<Record<string, LocalTargetState>>;
}>;

export type LocalTargetState = Readonly<{
  agentId: AgentId;
  mode: TargetMode;
  path: string;
}>;

export type LocalOperationalState = Readonly<{
  schemaVersion: 1;
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
}

export type RecoverLocalOperationalStateInput = Readonly<{
  desired: DesiredState;
  lastAppliedRevision: RevisionId | null;
  skillsStoragePath: string;
  homeDir: string;
  enabledAgentIds: readonly AgentId[];
}>;

/**
 * Recovers only assets whose Corotum ownership is provable: a locked,
 * hash-matching canonical copy and target symlinks resolving to that copy.
 * Equal-content regular directories are deliberately left unmanaged.
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
    const canonicalPath = join(input.skillsStoragePath, locked.id);
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
          };
        }
      }
    }

    skills[locked.id] = {
      canonicalPath,
      contentHash: locked.contentHash,
      targets,
    };
  }

  return {
    schemaVersion: 1,
    lastAppliedRevision: input.lastAppliedRevision,
    skills,
  };
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
    skills[parsedId] = { ...skill, targets };
  }

  return {
    schemaVersion: 1,
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
