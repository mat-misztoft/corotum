import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type DispositionLedger,
  type SkillId,
  type V2DesiredState,
  validateV2DesiredState,
} from "../../../packages/core/src/index";
import type {
  LocalOperationalState,
  LocalOperationalStateStore,
} from "./local-state";
import { type V2LocalApplier, V2LocalApplyError } from "./v2-local-applier";
import type { V2MutationProvider } from "./v2-mutations";

export type V2LifecycleOperation = "REMOVE" | "UNMANAGE" | "RESTORE";

export type V2LifecyclePhase = "desired-persisted" | "locally-applied";

export type V2LifecycleRecoveryMarker = Readonly<{
  schemaVersion: 1;
  operation: V2LifecycleOperation;
  phase: V2LifecyclePhase;
  skillId: SkillId;
  name: string;
  revision?: string;
}>;

export type V2LifecycleResult =
  | Readonly<{
      kind: "success";
      skillId: SkillId;
      revision: string;
      operation: V2LifecycleOperation;
    }>
  | Readonly<{
      kind: "persisted-not-applied";
      skillId: SkillId;
      revision: string;
      operation: V2LifecycleOperation;
      reason: string;
    }>
  | Readonly<{ kind: "local-conflict"; skillId: SkillId; reason: string }>
  | Readonly<{ kind: "drifted"; skillId: SkillId; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

export class LifecycleRecoveryStore {
  constructor(private readonly file: string) {}

  async load(): Promise<V2LifecycleRecoveryMarker | null> {
    try {
      const parsed = JSON.parse(
        await readFile(this.file, "utf8"),
      ) as V2LifecycleRecoveryMarker;
      if (parsed.schemaVersion !== 1 || !parsed.phase || !parsed.operation)
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(marker: V2LifecycleRecoveryMarker): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

type LifecycleApplier = Pick<
  V2LocalApplier,
  "applyRemove" | "applyUnmanage" | "applyRestore"
> &
  Partial<Pick<V2LocalApplier, "assertDestructiveSafe">>;

/**
 * Remove/unmanage persist a ledger tombstone before touching local files.
 * Restore never mutates desired state. Every boundary writes a recovery
 * marker so a retry cannot invent a synced status or destroy unmanaged data.
 */
export class V2LifecycleService {
  constructor(
    private readonly provider: V2MutationProvider,
    private readonly applier: LifecycleApplier,
    private readonly stateStore: LocalOperationalStateStore,
    private readonly recovery: LifecycleRecoveryStore,
  ) {}

  async remove(nameOrId: string): Promise<V2LifecycleResult> {
    return this.mutate("REMOVE", nameOrId);
  }

  async unmanage(nameOrId: string): Promise<V2LifecycleResult> {
    return this.mutate("UNMANAGE", nameOrId);
  }

  async restore(nameOrId: string): Promise<V2LifecycleResult> {
    try {
      const current = await this.provider.pull();
      const skill = select(current.state, nameOrId);
      if (!skill)
        return {
          kind: "refused",
          reason: "Managed skill was not found or is ambiguous.",
        };
      const marker = await this.recovery.load();
      if (
        marker &&
        (marker.skillId !== skill.id || marker.operation !== "RESTORE")
      ) {
        return {
          kind: "refused",
          reason:
            "A different interrupted lifecycle operation must finish first.",
        };
      }
      return await this.applyLocal({
        operation: "RESTORE",
        skillId: skill.id,
        name: skill.name,
        revision: current.revisionId,
        state: current.state,
        skipApply: false,
      });
    } catch (error) {
      return refused(error);
    }
  }

  private async mutate(
    operation: "REMOVE" | "UNMANAGE",
    nameOrId: string,
  ): Promise<V2LifecycleResult> {
    try {
      const current = await this.provider.pull();
      const skill = select(current.state, nameOrId);
      const marker = await this.recovery.load();
      if (marker && marker.operation !== operation) {
        return {
          kind: "refused",
          reason:
            "A different interrupted lifecycle operation must finish first.",
        };
      }
      if (!skill && !marker)
        return {
          kind: "refused",
          reason: "Managed skill was not found or is ambiguous.",
        };
      const id = skill?.id ?? marker!.skillId;
      const name = skill?.name ?? marker!.name;
      let revision = marker?.revision ?? current.revisionId;
      let persistedState = current.state;
      if (
        marker?.phase !== "desired-persisted" &&
        marker?.phase !== "locally-applied"
      ) {
        try {
          await this.applier.assertDestructiveSafe?.(id);
        } catch (error) {
          if (
            error instanceof V2LocalApplyError &&
            error.code === "LOCAL_CONFLICT"
          ) {
            return {
              kind: "local-conflict",
              skillId: id,
              reason: error.message,
            };
          }
          if (error instanceof V2LocalApplyError && error.code === "DRIFTED") {
            return { kind: "drifted", skillId: id, reason: error.message };
          }
          throw error;
        }
        const nextState = withoutSkill(current.state, id);
        const ledger = withTombstone(current.ledger, { id, name }, operation);
        const persisted = await this.provider.push({
          state: validateV2DesiredState(nextState),
          ledger,
          baseRevision: current.revisionId,
        });
        revision = persisted.revisionId;
        persistedState = persisted.state;
        await this.recovery.save({
          schemaVersion: 1,
          operation,
          phase: "desired-persisted",
          skillId: id,
          name,
          revision,
        });
      } else if (marker?.revision) {
        revision = marker.revision;
        persistedState = current.state;
      }
      return await this.applyLocal({
        operation,
        skillId: id,
        name,
        revision,
        state: persistedState,
        skipApply: marker?.phase === "locally-applied",
      });
    } catch (error) {
      return refused(error);
    }
  }

  private async applyLocal(
    input: Readonly<{
      operation: V2LifecycleOperation;
      skillId: SkillId;
      name: string;
      revision: string;
      state: V2DesiredState;
      skipApply: boolean;
    }>,
  ): Promise<V2LifecycleResult> {
    let next: LocalOperationalState;
    try {
      if (input.skipApply) {
        const saved = await this.loadState();
        next =
          input.operation === "RESTORE"
            ? saved
            : withoutLocalSkill(saved, input.skillId);
      } else if (input.operation === "REMOVE") {
        next = await this.applier.applyRemove(input.skillId);
      } else if (input.operation === "UNMANAGE") {
        next = await this.applier.applyUnmanage(input.skillId);
      } else {
        next = await this.applier.applyRestore({
          state: input.state,
          skillId: input.skillId,
        });
      }
    } catch (error) {
      if (
        error instanceof V2LocalApplyError &&
        error.code === "LOCAL_CONFLICT"
      ) {
        return {
          kind: "local-conflict",
          skillId: input.skillId,
          reason: error.message,
        };
      }
      if (error instanceof V2LocalApplyError && error.code === "DRIFTED") {
        return {
          kind: "drifted",
          skillId: input.skillId,
          reason: error.message,
        };
      }
      const reason =
        error instanceof Error ? error.message : "Local application failed.";
      if (input.operation === "RESTORE") return { kind: "refused", reason };
      return {
        kind: "persisted-not-applied",
        skillId: input.skillId,
        revision: input.revision,
        operation: input.operation,
        reason,
      };
    }

    await this.recovery.save({
      schemaVersion: 1,
      operation: input.operation,
      phase: "locally-applied",
      skillId: input.skillId,
      name: input.name,
      revision: input.revision,
    });

    try {
      await this.stateStore.save({
        ...next,
        schemaVersion: 2,
        lastAppliedRevision: (input.operation === "RESTORE"
          ? next.lastAppliedRevision
          : input.revision) as never,
      });
    } catch (error) {
      return {
        kind: "persisted-not-applied",
        skillId: input.skillId,
        revision: input.revision,
        operation: input.operation,
        reason:
          error instanceof Error
            ? error.message
            : "Operational state could not be saved.",
      };
    }

    await this.recovery.clear();
    return {
      kind: "success",
      skillId: input.skillId,
      revision: input.revision,
      operation: input.operation,
    };
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
}

function select(state: V2DesiredState, nameOrId: string) {
  const matches = state.manifest.skills.filter(
    (skill) => skill.id === nameOrId || skill.name === nameOrId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function withoutSkill(state: V2DesiredState, id: SkillId): V2DesiredState {
  return {
    manifest: {
      version: 2,
      skills: state.manifest.skills.filter((skill) => skill.id !== id),
    },
    lockfile: {
      version: 2,
      skills: state.lockfile.skills.filter((skill) => skill.id !== id),
    },
  };
}

function withoutLocalSkill(
  state: LocalOperationalState,
  id: SkillId,
): LocalOperationalState {
  if (!state.skills[id]) return state;
  const skills = { ...state.skills };
  delete skills[id];
  return { ...state, skills };
}

function withTombstone(
  ledger: DispositionLedger,
  skill: Readonly<{ id: SkillId; name: string }>,
  disposition: "REMOVE" | "UNMANAGE",
): DispositionLedger {
  const next =
    Math.max(
      0,
      ...Object.values(ledger.activeDispositions).map(
        (entry) => entry.effectiveSequence,
      ),
    ) + 1;
  return {
    version: 2,
    activeDispositions: {
      ...ledger.activeDispositions,
      [skill.id]: {
        skillId: skill.id,
        name: skill.name,
        disposition,
        effectiveSequence: next,
      },
    },
    audit: [
      ...(ledger.audit ?? []),
      { type: disposition, skillId: skill.id, metadata: {} },
    ],
  };
}

function refused(error: unknown): V2LifecycleResult {
  return {
    kind: "refused",
    reason:
      error instanceof Error ? error.message : "Desired state mutation failed.",
  };
}
