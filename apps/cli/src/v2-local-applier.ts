import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentId } from "../../../packages/agent-targets/src/index";
import { AgentTargetManager } from "../../../packages/agent-targets/src/targets";
import type { SkillId, V2DesiredState } from "../../../packages/core/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import { ExactContentMaterializer } from "../../../packages/skills-adapter/src/exact-materializer";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import type { V2LocalApplier as V2LocalApplierContract } from "./v2-mutations";
import {
  type LocalOperationalStateStore,
  managedTargetsFromState,
} from "./local-state";

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
    }>,
    private readonly targets = new AgentTargetManager(),
  ) {}

  async apply(input: Readonly<{
    state: V2DesiredState;
    revisionId: string;
    skillIds: readonly SkillId[];
  }>): Promise<void> {
    const saved = (await this.stateStore.load()) ?? {
      schemaVersion: 2 as const,
      lastAppliedRevision: null,
      skills: {},
    };
    const skills = { ...saved.skills };
    let ownership = managedTargetsFromState(saved);
    for (const id of input.skillIds) {
      const lock = input.state.lockfile.skills.find((skill) => skill.id === id);
      const manifest = input.state.manifest.skills.find((skill) => skill.id === id);
      if (!lock || !manifest) throw new Error("Persisted skill is incomplete.");
      const staged = await this.materializer().stage(lock);
      try {
        const expected = lock.materialization.kind === "source"
          ? lock.materialization.contentHash
          : lock.materialization.artifact.contentHash;
        const prior = skills[id];
        if (prior && (await scanNormalizedContent(prior.canonicalPath)).contentHash !== prior.contentHash) {
          throw new Error("Canonical content differs from the last verified copy.");
        }
        await this.canonicalStore.replaceFromDirectory(
          id,
          lock.name,
          staged.directory,
          await hashSkillDirectory(staged.directory),
          prior ? { skillId: id, contentHash: prior.contentHash, allowDrift: true } : undefined,
        );
        const canonicalPath = this.canonicalStore.pathFor(lock.name);
        if ((await scanNormalizedContent(canonicalPath)).contentHash !== expected) {
          throw new Error("Canonical skill content did not match the persisted lock.");
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
        if (exposed.outcomes.some((outcome) => outcome.status === "ERROR" || outcome.status === "LOCAL_CONFLICT")) {
          throw new Error(exposed.outcomes.find((outcome) => outcome.error)?.error ?? "Local target application failed.");
        }
        ownership = exposed.ownership;
        skills[id] = {
          name: lock.name,
          canonicalPath,
          contentHash: expected,
          ownership: "verified",
          targets: Object.fromEntries(exposed.ownership.filter((target) => target.skillId === id).map((target) => [
            `${target.agentId}\0${target.path}`,
            { agentId: target.agentId, mode: target.mode, path: target.path, expectedHash: target.expectedHash },
          ])),
        };
      } finally {
        await staged.cleanup();
      }
    }
    await this.stateStore.save({ schemaVersion: 2, lastAppliedRevision: input.revisionId as never, skills });
  }

  private materializer(): ExactContentMaterializer {
    return new ExactContentMaterializer(undefined, async (locator) =>
      new Uint8Array(await readFile(join(this.input.storagePath, sourceKey(this.input.repository), locator))),
    );
  }
}

function sourceKey(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}
