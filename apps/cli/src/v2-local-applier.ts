import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { AgentId } from "../../../packages/agent-targets/src/index";
import {
  AgentTargetManager,
  type ManagedTarget,
  type TargetOutcome,
} from "../../../packages/agent-targets/src/targets";
import {
  type SkillId,
  skillId,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import {
  type CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import {
  type ArtifactReader,
  ExactContentMaterializer,
} from "../../../packages/skills-adapter/src/exact-materializer";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import {
  type LocalOperationalState,
  type LocalOperationalStateStore,
  type LocalTargetState,
  managedTargetsFromState,
} from "./local-state";
import type { V2LocalApplier as V2LocalApplierContract } from "./v2-mutations";

export class V2LocalApplyError extends Error {
  readonly name = "V2LocalApplyError";
  constructor(
    message: string,
    readonly code: "LOCAL_CONFLICT" | "DRIFTED" | "ERROR" = "ERROR",
  ) {
    super(message);
  }
}

/** Installs only exact v2 locks after their desired-state commit is durable. */
export class V2LocalApplier implements V2LocalApplierContract {
  constructor(
    private readonly stateStore: LocalOperationalStateStore,
    private readonly canonicalStore: CanonicalSkillStore,
    private readonly input: Readonly<{
      storagePath: string;
      repository: string;
      enabledAgentIds: readonly AgentId[];
      homeDir: string;
      artifactReader?: ArtifactReader;
    }>,
    private readonly targets = new AgentTargetManager(),
  ) {}

  async apply(
    input: Readonly<{
      state: V2DesiredState;
      revisionId: string;
      skillIds: readonly SkillId[];
      advanceRevision?: boolean;
    }>,
  ): Promise<void> {
    const saved = (await this.stateStore.load()) ?? {
      schemaVersion: 2 as const,
      lastAppliedRevision: null,
      skills: {},
    };
    const skills = { ...saved.skills };
    let ownership = managedTargetsFromState(saved);
    for (const id of input.skillIds) {
      const lock = input.state.lockfile.skills.find((skill) => skill.id === id);
      const manifest = input.state.manifest.skills.find(
        (skill) => skill.id === id,
      );
      if (!lock || !manifest) throw new Error("Persisted skill is incomplete.");
      const expected =
        lock.materialization.kind === "source"
          ? lock.materialization.contentHash
          : lock.materialization.artifact.contentHash;
      const canonicalPath = this.canonicalStore.pathFor(lock.name);
      let prior = skills[id];
      if (!prior && (await pathExists(canonicalPath))) {
        let existingHash: string;
        try {
          existingHash = (await scanNormalizedContent(canonicalPath))
            .contentHash;
        } catch {
          throw new V2LocalApplyError(
            "Unmanaged or unreadable named canonical skill blocked install.",
            "LOCAL_CONFLICT",
          );
        }
        if (existingHash !== expected) {
          throw new V2LocalApplyError(
            "Unmanaged named canonical skill differs from the locked hash.",
            "LOCAL_CONFLICT",
          );
        }
        prior = {
          name: lock.name,
          canonicalPath,
          contentHash: expected,
          ownership: "verified",
          targets: {},
        };
      }
      if (prior && (await pathExists(prior.canonicalPath))) {
        const priorHash = (await scanNormalizedContent(prior.canonicalPath))
          .contentHash;
        if (priorHash !== prior.contentHash && priorHash !== expected) {
          throw new Error(
            "Canonical content differs from the last verified copy.",
          );
        }
        if (priorHash === expected) {
          const exposed = await this.targets.expose({
            skillId: id,
            skillName: lock.name,
            canonicalPath,
            targets: manifest.targets,
            enabledAgentIds: this.input.enabledAgentIds,
            homeDir: this.input.homeDir,
            ownership,
            expectedContentHash: expected,
          });
          this.assertTargetSuccess(exposed.outcomes);
          ownership = exposed.ownership;
          skills[id] = {
            name: lock.name,
            canonicalPath,
            contentHash: expected,
            ownership: "verified",
            targets: Object.fromEntries(
              exposed.ownership
                .filter((target) => target.skillId === id)
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
          continue;
        }
      }
      const staged = await this.materializer().stage(lock);
      try {
        await this.canonicalStore.replaceFromDirectory(
          id,
          lock.name,
          staged.directory,
          await hashSkillDirectory(staged.directory),
          prior
            ? { skillId: id, contentHash: prior.contentHash, allowDrift: true }
            : undefined,
        );
        if (
          (await scanNormalizedContent(canonicalPath)).contentHash !== expected
        ) {
          throw new Error(
            "Canonical skill content did not match the persisted lock.",
          );
        }
        const exposed = await this.targets.expose({
          skillId: id,
          skillName: lock.name,
          canonicalPath,
          targets: manifest.targets,
          enabledAgentIds: this.input.enabledAgentIds,
          homeDir: this.input.homeDir,
          ownership,
          expectedContentHash: expected,
        });
        if (
          exposed.outcomes.some(
            (outcome) =>
              outcome.status === "ERROR" || outcome.status === "LOCAL_CONFLICT",
          )
        ) {
          const conflict = exposed.outcomes.find(
            (outcome) => outcome.status === "LOCAL_CONFLICT",
          );
          if (conflict) {
            throw new V2LocalApplyError(
              `Unmanaged or ambiguous target exists at ${conflict.path}.`,
              "LOCAL_CONFLICT",
            );
          }
          throw new Error(
            exposed.outcomes.find((outcome) => outcome.error)?.error ??
              "Local target application failed.",
          );
        }
        ownership = exposed.ownership;
        skills[id] = {
          name: lock.name,
          canonicalPath,
          contentHash: expected,
          ownership: "verified",
          targets: Object.fromEntries(
            exposed.ownership
              .filter((target) => target.skillId === id)
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
    await this.stateStore.save({
      schemaVersion: 2,
      lastAppliedRevision: (input.advanceRevision === false
        ? saved.lastAppliedRevision
        : input.revisionId) as never,
      skills,
    });
  }

  /** Exposes managed canonical skills to currently enabled agents. Desired state is unchanged. */
  async applyEnableAgent(
    desired?: V2DesiredState,
  ): Promise<readonly TargetOutcome[]> {
    const saved = await this.loadState();
    let ownership = managedTargetsFromState(saved);
    const skills = { ...saved.skills };
    const outcomes: TargetOutcome[] = [];
    for (const [id, skill] of Object.entries(skills)) {
      const currentId = skillId(id);
      const targets =
        desired?.manifest.skills.find((entry) => entry.id === currentId)
          ?.targets ?? "all";
      const exposed = await this.targets.expose({
        skillId: currentId,
        skillName: skill.name,
        canonicalPath: skill.canonicalPath,
        targets,
        enabledAgentIds: this.input.enabledAgentIds,
        homeDir: this.input.homeDir,
        ownership,
        expectedContentHash: skill.contentHash,
      });
      this.assertTargetSuccess(exposed.outcomes);
      ownership = exposed.ownership;
      outcomes.push(...exposed.outcomes);
      skills[currentId] = {
        ...skill,
        targets: targetsFromOwnership(currentId, ownership),
      };
    }
    await this.stateStore.save({
      schemaVersion: 2,
      lastAppliedRevision: saved.lastAppliedRevision,
      skills,
    });
    return outcomes;
  }

  /** Removes one agent's recorded exposure without deleting global managed skills. */
  async applyDisableAgent(agentId: AgentId): Promise<readonly TargetOutcome[]> {
    const saved = await this.loadState();
    let ownership = managedTargetsFromState(saved);
    const skills = { ...saved.skills };
    const outcomes: TargetOutcome[] = [];
    for (const id of Object.keys(skills)) {
      const currentId = skillId(id);
      const disabled = await this.targets.disable(
        currentId,
        agentId,
        ownership,
      );
      this.assertTargetSuccess(disabled.outcomes);
      ownership = disabled.ownership;
      outcomes.push(...disabled.outcomes);
      const skill = skills[currentId];
      if (!skill) continue;
      skills[currentId] = {
        ...skill,
        targets: targetsFromOwnership(currentId, ownership),
      };
    }
    await this.stateStore.save({
      schemaVersion: 2,
      lastAppliedRevision: saved.lastAppliedRevision,
      skills,
    });
    return outcomes;
  }

  /** Verifies recorded ownership before a REMOVE/UNMANAGE desired-state push. */
  async assertDestructiveSafe(skillId: SkillId): Promise<void> {
    const saved = await this.loadState();
    const skill = saved.skills[skillId];
    if (!skill) return;
    const ownership = managedTargetsFromState(saved);
    await this.assertSafeDestructiveTargets(
      skill.canonicalPath,
      skill.contentHash,
      ownership.filter((target) => target.skillId === skillId),
    );
  }

  /** Deletes only hash-verified canonical and target ownership. */
  async applyRemove(skillId: SkillId): Promise<LocalOperationalState> {
    const saved = await this.loadState();
    const skill = saved.skills[skillId];
    if (!skill) return saved;
    const ownership = managedTargetsFromState(saved);
    const targets = ownership.filter((target) => target.skillId === skillId);
    await this.assertSafeDestructiveTargets(
      skill.canonicalPath,
      skill.contentHash,
      targets,
    );
    const removed = await this.targets.remove(skillId, ownership);
    this.assertTargetSuccess(removed.outcomes);
    if (await pathExists(skill.canonicalPath)) {
      await this.canonicalStore.remove(
        skillId,
        skill.name,
        await hashSkillDirectory(skill.canonicalPath),
      );
    }
    const skills = { ...saved.skills };
    delete skills[skillId];
    return {
      schemaVersion: 2,
      lastAppliedRevision: saved.lastAppliedRevision,
      skills,
    };
  }

  /** Converts verified symlinks to copies, then drops Corotum ownership. */
  async applyUnmanage(skillId: SkillId): Promise<LocalOperationalState> {
    const saved = await this.loadState();
    const skill = saved.skills[skillId];
    if (!skill) return saved;
    const ownership = managedTargetsFromState(saved);
    const targets = ownership.filter((target) => target.skillId === skillId);
    await this.assertSafeDestructiveTargets(
      skill.canonicalPath,
      skill.contentHash,
      targets,
    );
    const unmanaged = await this.targets.unmanage(skillId, ownership);
    this.assertTargetSuccess(unmanaged.outcomes);
    const skills = { ...saved.skills };
    delete skills[skillId];
    return {
      schemaVersion: 2,
      lastAppliedRevision: saved.lastAppliedRevision,
      skills,
    };
  }

  /** Repairs recorded/recovered verified targets from the exact persisted lock. */
  async applyRestore(
    input: Readonly<{
      state: V2DesiredState;
      skillId: SkillId;
    }>,
  ): Promise<LocalOperationalState> {
    const saved = await this.loadState();
    const recorded = saved.skills[input.skillId];
    if (
      !recorded ||
      (recorded.ownership !== "verified" && recorded.ownership !== "recovered")
    ) {
      throw new V2LocalApplyError(
        "Restore will not claim an unrecorded or unverified skill.",
        "LOCAL_CONFLICT",
      );
    }
    const lock = input.state.lockfile.skills.find(
      (skill) => skill.id === input.skillId,
    );
    const manifest = input.state.manifest.skills.find(
      (skill) => skill.id === input.skillId,
    );
    if (!lock || !manifest) throw new Error("Persisted skill is incomplete.");
    const expected =
      lock.materialization.kind === "source"
        ? lock.materialization.contentHash
        : lock.materialization.artifact.contentHash;
    const ownership = managedTargetsFromState(saved);
    const targets = ownership.filter(
      (target) => target.skillId === input.skillId,
    );
    for (const target of targets) {
      if (!(await pathExists(target.path))) continue;
      if (!(await this.isVerifiedTarget(target))) {
        throw new V2LocalApplyError(
          `Managed target at ${target.path} drifted or was replaced; restore will not overwrite it.`,
          target.mode === "copy" ? "DRIFTED" : "LOCAL_CONFLICT",
        );
      }
    }
    const staged = await this.materializer().stage(lock);
    try {
      await this.canonicalStore.replaceFromDirectory(
        input.skillId,
        lock.name,
        staged.directory,
        await hashSkillDirectory(staged.directory),
        {
          skillId: input.skillId,
          contentHash: recorded.contentHash,
          allowDrift: true,
        },
      );
      const canonicalPath = this.canonicalStore.pathFor(lock.name);
      if (
        (await scanNormalizedContent(canonicalPath)).contentHash !== expected
      ) {
        throw new Error(
          "Canonical skill content did not match the persisted lock.",
        );
      }
      const restored = await this.targets.restore(
        input.skillId,
        canonicalPath,
        ownership,
      );
      this.assertTargetSuccess(restored.outcomes);
      const skills = {
        ...saved.skills,
        [input.skillId]: {
          name: lock.name,
          canonicalPath,
          contentHash: expected,
          ownership: "verified" as const,
          targets: Object.fromEntries(
            restored.ownership
              .filter((target) => target.skillId === input.skillId)
              .map((target) => [
                `${target.agentId}\0${target.path}`,
                {
                  agentId: target.agentId,
                  mode: target.mode,
                  path: target.path,
                  expectedHash: expected,
                },
              ]),
          ),
        },
      };
      return {
        schemaVersion: 2,
        lastAppliedRevision: saved.lastAppliedRevision,
        skills,
      };
    } finally {
      await staged.cleanup();
    }
  }

  private async loadState(): Promise<LocalOperationalState> {
    return (
      (await this.stateStore.load()) ?? {
        schemaVersion: 2,
        lastAppliedRevision: null,
        skills: {},
      }
    );
  }

  private async assertSafeDestructiveTargets(
    canonicalPath: string,
    expectedContentHash: string,
    targets: readonly ManagedTarget[],
  ): Promise<void> {
    if (await pathExists(canonicalPath)) {
      const actual = (await scanNormalizedContent(canonicalPath)).contentHash;
      if (actual !== expectedContentHash) {
        throw new V2LocalApplyError(
          "Named canonical skill is not verified Corotum-owned content.",
          "DRIFTED",
        );
      }
    }
    for (const target of targets) {
      if (!(await pathExists(target.path))) continue;
      if (!(await this.isVerifiedTarget(target))) {
        throw new V2LocalApplyError(
          `Unmanaged or ambiguous target exists at ${target.path}.`,
          "LOCAL_CONFLICT",
        );
      }
    }
  }

  private async isVerifiedTarget(target: ManagedTarget): Promise<boolean> {
    if (!(await pathExists(target.path))) return false;
    if (target.mode === "copy") {
      return (await hashSkillDirectory(target.path)) === target.expectedHash;
    }
    try {
      const metadata = await lstat(target.path);
      return (
        metadata.isSymbolicLink() &&
        (await realpath(target.path)) === (await realpath(target.canonicalPath))
      );
    } catch {
      return false;
    }
  }

  private assertTargetSuccess(
    outcomes: readonly { status: string; error?: string }[],
  ): void {
    const failed = outcomes.find(
      (outcome) =>
        outcome.status === "ERROR" || outcome.status === "LOCAL_CONFLICT",
    );
    if (!failed) return;
    if (failed.status === "LOCAL_CONFLICT") {
      throw new V2LocalApplyError(
        "Unmanaged or ambiguous target blocked the operation.",
        "LOCAL_CONFLICT",
      );
    }
    throw new Error(failed.error ?? "Local target application failed.");
  }

  private materializer(): ExactContentMaterializer {
    const treePath = (locator: string) =>
      join(this.input.storagePath, sourceKey(this.input.repository), locator);
    return new ExactContentMaterializer(
      undefined,
      this.input.artifactReader ??
        (async (locator) => new Uint8Array(await readFile(treePath(locator)))),
      async (locator) => treePath(locator),
    );
  }
}

function targetsFromOwnership(
  id: SkillId,
  ownership: readonly ManagedTarget[],
): Record<string, LocalTargetState> {
  return Object.fromEntries(
    ownership
      .filter((target) => target.skillId === id)
      .map((target) => [
        `${target.agentId}\0${target.path}`,
        {
          agentId: target.agentId,
          mode: target.mode,
          path: target.path,
          expectedHash: target.expectedHash,
        },
      ]),
  );
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
