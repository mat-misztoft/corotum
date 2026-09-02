import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentId } from "../../../packages/agent-targets/src/index";
import { AgentTargetManager } from "../../../packages/agent-targets/src/targets";
import {
  type DispositionLedger,
  type SkillId,
  type SourceMetadata,
  type V2DesiredState,
  type V2LockedSkill,
  skillId,
  validateV2DesiredState,
} from "../../../packages/core/src/index";
import { gitTreeHash, V2ArtifactConsentRequiredError } from "../../../packages/git-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import { ExactContentMaterializer } from "../../../packages/skills-adapter/src/exact-materializer";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import type { InitSkillOutcome } from "./init-adoption";
import {
  type LocalOperationalState,
  type LocalOperationalStateStore,
  managedTargetsFromState,
} from "./local-state";

export type InitV2Provider = Readonly<{
  pull: () => Promise<{
    revisionId: string | null;
    state: V2DesiredState;
    ledger: DispositionLedger;
  }>;
  push: (input: {
    state: V2DesiredState;
    ledger: DispositionLedger;
    baseRevision: string | null;
    artifacts: Readonly<Record<string, string>>;
  }) => Promise<{
    revisionId: string;
    state: V2DesiredState;
    ledger: DispositionLedger;
  }>;
}>;

export type InitTransactionBackend =
  | Readonly<{ kind: "git" }>
  | Readonly<{ kind: "cloud"; workspaceId: string }>;

export type InitRecoveryPhase =
  | "prepared"
  | "desired-persisted"
  | "locally-verified"
  | "config-persisted";

export type PreparedInitSkill = Readonly<{
  id: SkillId;
  name: string;
  path: string;
  kind: "source-backed" | "artifact-backed";
}>;

export type InitRecoveryMarker = Readonly<{
  schemaVersion: 1;
  phase: InitRecoveryPhase;
  backend: "git" | "cloud";
  skillIds: readonly SkillId[];
  skills: readonly PreparedInitSkill[];
  revision?: string;
  gitRepository?: string;
  enabledAgentIds?: readonly string[];
}>;

export type InitTransactionResult =
  | Readonly<{
      kind: "initialized";
      revision: string;
      skillIds: readonly SkillId[];
      outcomes: readonly InitSkillOutcome[];
    }>
  | Readonly<{
      kind: "partial";
      revision: string;
      skillIds: readonly SkillId[];
      reason: string;
      phase: InitRecoveryPhase;
      outcomes: readonly InitSkillOutcome[];
    }>
  | Readonly<{ kind: "refused"; reason: string; outcomes: readonly InitSkillOutcome[] }>;

export class InitRecoveryStore {
  constructor(private readonly file: string) {}

  async load(): Promise<InitRecoveryMarker | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as InitRecoveryMarker;
      if (parsed.schemaVersion !== 1 || !parsed.phase) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(marker: InitRecoveryMarker): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/**
 * Stages selected init decisions into one v2 desired-state mutation. Each
 * boundary writes a recovery marker so a retry cannot invent new IDs or claim
 * ownership of unselected local content.
 */
export class InitTransactionService {
  constructor(
    private readonly deps: Readonly<{
      provider: InitV2Provider;
      recovery: InitRecoveryStore;
      persistConfig: () => Promise<void>;
      backend: InitTransactionBackend;
      apply?: (input: {
        state: V2DesiredState;
        revisionId: string;
        skills: readonly PreparedInitSkill[];
      }) => Promise<void>;
      createSkillId?: () => SkillId;
      stateStore?: LocalOperationalStateStore;
      canonicalStore?: CanonicalSkillStore;
      enabledAgentIds?: readonly AgentId[];
      homeDir?: string;
      gitRepository?: string;
      gitStoragePath?: string;
    }>,
  ) {}

  async run(input: {
    outcomes: readonly InitSkillOutcome[];
    executionState?: LocalOperationalState;
  }): Promise<InitTransactionResult> {
    const outcomes = input.outcomes;
    const adopted = outcomes.filter(
      (outcome): outcome is Extract<InitSkillOutcome, { kind: "source-backed" | "artifact-backed" }> =>
        outcome.kind === "source-backed" || outcome.kind === "artifact-backed",
    );

    let marker = await this.deps.recovery.load();
    if (!marker) {
      marker = {
        schemaVersion: 1,
        phase: "prepared",
        backend: this.deps.backend.kind,
        skillIds: adopted.map(() => this.nextId()),
        skills: [],
        gitRepository: this.deps.gitRepository,
        enabledAgentIds: this.deps.enabledAgentIds,
      };
      marker = {
        ...marker,
        skills: adopted.map((outcome, index) => ({
          id: marker!.skillIds[index]!,
          name: outcome.name,
          path: outcome.path,
          kind: outcome.kind,
        })),
      };
      await this.deps.recovery.save(marker);
    }

    const current = await this.deps.provider.pull();
    if (
      current.state.manifest.skills.length > 0 &&
      !sameAdoption(current.state, marker.skillIds)
    ) {
      if (marker.skillIds.length === 0) {
        if (!current.revisionId) {
          return {
            kind: "refused",
            reason: "Existing desired state is missing a revision.",
            outcomes,
          };
        }
        const revision = current.revisionId;
        try {
          await this.deps.persistConfig();
        } catch (error) {
          return {
            kind: "partial",
            revision,
            skillIds: [],
            reason:
              error instanceof Error
                ? error.message
                : "Local configuration could not be saved.",
            phase: "locally-verified",
            outcomes,
          };
        }
        await this.deps.recovery.clear();
        return {
          kind: "initialized",
          revision,
          skillIds: [],
          outcomes,
        };
      }
      return {
        kind: "refused",
        reason: `Corotum is already initialized for this ${this.deps.backend.kind === "cloud" ? "Cloud workspace" : "Git repository"}.`,
        outcomes,
      };
    }

    if (
      marker.phase === "prepared" &&
      marker.skillIds.length > 0 &&
      sameAdoption(current.state, marker.skillIds) &&
      current.revisionId
    ) {
      marker = { ...marker, phase: "desired-persisted", revision: current.revisionId };
      await this.deps.recovery.save(marker);
    } else if (marker.phase === "prepared") {
      const prepared = await this.buildState(adopted, marker, current.ledger);
      try {
        const pushed = await this.deps.provider.push({
          state: prepared.state,
          ledger: prepared.ledger,
          baseRevision: current.revisionId,
          artifacts: prepared.artifacts,
        });
        marker = {
          ...marker,
          phase: "desired-persisted",
          revision: pushed.revisionId,
        };
        await this.deps.recovery.save(marker);
      } catch (error) {
        if (error instanceof V2ArtifactConsentRequiredError) throw error;
        return {
          kind: "refused",
          reason: error instanceof Error ? error.message : "Initial desired state could not be saved.",
          outcomes,
        };
      }
    }

    const revision = marker.revision;
    if (!revision) {
      return { kind: "refused", reason: "Init recovery is missing the persisted revision.", outcomes };
    }

    if (marker.phase === "desired-persisted") {
      try {
        const snapshot = await this.deps.provider.pull();
        await this.applyLocal(snapshot.state, revision, marker.skills);
        marker = { ...marker, phase: "locally-verified", revision };
        await this.deps.recovery.save(marker);
      } catch (error) {
        return {
          kind: "partial",
          revision,
          skillIds: marker.skillIds,
          reason: error instanceof Error ? error.message : "Local skill targets could not be adopted.",
          phase: "desired-persisted",
          outcomes,
        };
      }
    }

    if (marker.phase === "locally-verified") {
      try {
        await this.deps.persistConfig();
        marker = { ...marker, phase: "config-persisted" };
        await this.deps.recovery.save(marker);
      } catch (error) {
        return {
          kind: "partial",
          revision,
          skillIds: marker.skillIds,
          reason: error instanceof Error ? error.message : "Local configuration could not be saved.",
          phase: "locally-verified",
          outcomes,
        };
      }
    }

    await this.deps.recovery.clear();
    return { kind: "initialized", revision, skillIds: marker.skillIds, outcomes };
  }

  private nextId(): SkillId {
    return this.deps.createSkillId?.() ?? skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
  }

  private async buildState(
    adopted: readonly Extract<InitSkillOutcome, { kind: "source-backed" | "artifact-backed" }>[],
    marker: InitRecoveryMarker,
    ledger: DispositionLedger,
  ): Promise<{
    state: V2DesiredState;
    ledger: DispositionLedger;
    artifacts: Record<string, string>;
  }> {
    const artifacts: Record<string, string> = {};
    const manifestSkills: V2DesiredState["manifest"]["skills"][number][] = [];
    const locks: V2LockedSkill[] = [];

    for (const [index, outcome] of adopted.entries()) {
      const id = marker.skillIds[index]!;
      if (outcome.kind === "source-backed") {
        const source: SourceMetadata = {
          repository: outcome.source.repository,
          path: outcome.source.path,
          ref: outcome.source.ref,
        };
        manifestSkills.push({
          id,
          name: outcome.name,
          targets: "all",
          source,
          resolutionStatus: "RESOLVED",
        });
        locks.push({
          id,
          name: outcome.name,
          source: outcome.source,
          materialization: { kind: "source", contentHash: outcome.source.contentHash },
        });
        continue;
      }

      const scanned = await scanNormalizedContent(outcome.path);
      if (scanned.contentHash !== outcome.localContentHash) {
        throw new Error(`Local content for ${outcome.name} changed after adoption selection.`);
      }
      const artifact = await this.artifactMetadata(id, outcome.path, scanned);
      artifacts[id] = outcome.path;
      manifestSkills.push({
        id,
        name: outcome.name,
        targets: "all",
        source: retainedManifestSource(outcome.source),
        resolutionStatus: "RESOLVED",
      });
      locks.push({
        id,
        name: outcome.name,
        materialization: { kind: "artifact", artifact },
      });
    }

    const state = validateV2DesiredState({
      manifest: { version: 2, skills: manifestSkills },
      lockfile: { version: 2, skills: locks },
    });
    const audit = marker.skillIds.map((id) => ({
      type: "ADOPT" as const,
      skillId: id,
      metadata: { origin: "init" },
    }));
    return {
      state,
      ledger: {
        version: 2,
        activeDispositions: ledger.activeDispositions,
        ...(audit.length > 0 ? { audit } : {}),
      },
      artifacts,
    };
  }

  private async artifactMetadata(
    id: SkillId,
    path: string,
    scanned: Awaited<ReturnType<typeof scanNormalizedContent>>,
  ) {
    const sizeBytes = scanned.files.reduce((total, file) => total + file.content.byteLength, 0);
    if (this.deps.backend.kind === "cloud") {
      const archive = await createArtifactArchive(path);
      return {
        kind: "r2-tar-zst" as const,
        contentHash: archive.contentHash,
        integrityHash: archive.integrityHash,
        locator: `workspaces/${this.deps.backend.workspaceId}/artifacts/${id}/${archive.integrityHash}.tar.zst`,
        sizeBytes: archive.sizeBytes,
      };
    }
    const integrityHash = await gitTreeHash(path);
    return {
      kind: "git-tree" as const,
      contentHash: scanned.contentHash,
      integrityHash,
      locator: `artifacts/${id}/${integrityHash.slice("sha256:".length)}`,
      sizeBytes,
    };
  }

  private async applyLocal(
    state: V2DesiredState,
    revisionId: string,
    skills: readonly PreparedInitSkill[],
  ): Promise<void> {
    if (this.deps.apply) {
      await this.deps.apply({ state, revisionId, skills });
      return;
    }
    const stateStore = this.deps.stateStore;
    const canonicalStore = this.deps.canonicalStore;
    const homeDir = this.deps.homeDir;
    if (!stateStore || !canonicalStore || !homeDir) {
      throw new Error("Init local installation is not configured.");
    }
    const saved = (await stateStore.load()) ?? {
      schemaVersion: 2 as const,
      lastAppliedRevision: null,
      skills: {},
    };
    const nextSkills = { ...saved.skills };
    let ownership = managedTargetsFromState(saved);
    const targets = new AgentTargetManager();
    const materializer = new ExactContentMaterializer(
      undefined,
      this.deps.gitStoragePath && this.deps.gitRepository
        ? async (locator) =>
            new Uint8Array(
              await readFile(
                `${this.deps.gitStoragePath}/${sourceKey(this.deps.gitRepository!)}/${locator}`,
              ),
            )
        : undefined,
    );

    for (const prepared of skills) {
      const lock = state.lockfile.skills.find((skill) => skill.id === prepared.id);
      const manifest = state.manifest.skills.find((skill) => skill.id === prepared.id);
      if (!lock || !manifest) throw new Error("Persisted skill is incomplete.");
      const expected =
        lock.materialization.kind === "source"
          ? lock.materialization.contentHash
          : lock.materialization.artifact.contentHash;
      const staged =
        prepared.kind === "source-backed"
          ? await materializer.stage(lock)
          : { directory: prepared.path, cleanup: async () => undefined };
      try {
        const canonicalPath = canonicalStore.pathFor(lock.name);
        const alreadyMatches =
          (await pathExists(canonicalPath)) &&
          (await scanNormalizedContent(canonicalPath)).contentHash === expected;
        if (!alreadyMatches) {
          const stagedHash = await hashSkillDirectory(staged.directory);
          await canonicalStore.replaceFromDirectory(
            prepared.id,
            lock.name,
            staged.directory,
            stagedHash,
            (await pathExists(canonicalPath))
              ? {
                  skillId: prepared.id,
                  contentHash: stagedHash,
                  allowDrift: true,
                }
              : undefined,
          );
          if ((await scanNormalizedContent(canonicalPath)).contentHash !== expected) {
            throw new Error("Canonical skill content did not match the persisted lock.");
          }
        }
        const exposed = await targets.expose({
          skillId: prepared.id,
          skillName: lock.name,
          canonicalPath,
          targets: manifest.targets,
          enabledAgentIds: this.deps.enabledAgentIds ?? [],
          homeDir,
          ownership,
          expectedContentHash: expected,
        });
        if (exposed.outcomes.some((outcome) => outcome.status === "ERROR" || outcome.status === "LOCAL_CONFLICT")) {
          throw new Error(
            exposed.outcomes.find((outcome) => outcome.error)?.error ?? "Local target application failed.",
          );
        }
        ownership = exposed.ownership;
        nextSkills[prepared.id] = {
          name: lock.name,
          canonicalPath,
          contentHash: expected,
          ownership: "verified",
          targets: Object.fromEntries(
            exposed.ownership
              .filter((target) => target.skillId === prepared.id)
              .map((target) => [
                `${target.agentId}\0${target.path}`,
                {
                  agentId: target.agentId,
                  mode: target.mode,
                  path: target.path,
                  expectedHash: target.expectedHash,
                },
              ]),
          ),
        };
      } finally {
        await staged.cleanup();
      }
    }

    await stateStore.save({
      schemaVersion: 2,
      lastAppliedRevision: revisionId as never,
      skills: nextSkills,
    });
  }
}

function sameAdoption(state: V2DesiredState, skillIds: readonly SkillId[]): boolean {
  const current = [...state.manifest.skills.map((skill) => skill.id)].sort();
  const expected = [...skillIds].sort();
  return current.length === expected.length && current.every((id, index) => id === expected[index]);
}

function retainedManifestSource(source: InitSkillOutcome["source"]): SourceMetadata | null {
  if (!source?.repository || !source.path || !source.ref) return null;
  return { repository: source.repository, path: source.path, ref: source.ref };
}

function sourceKey(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
