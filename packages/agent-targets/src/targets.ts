import { cp, lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AgentTargets, SkillId } from "../../core/src/index";
import { hashSkillDirectory } from "../../skills-adapter/src/canonical-store";
import { type AgentAdapter, type AgentId, builtInAgentAdapters } from "./index";

export type TargetMode = "symlink" | "copy";

/** A local path ToolMirror is allowed to change. */
export type ManagedTarget = Readonly<{
  skillId: SkillId;
  agentId: AgentId;
  path: string;
  canonicalPath: string;
  mode: TargetMode;
}>;

export type TargetOwnership = readonly ManagedTarget[];

export type TargetOutcome = Readonly<{
  agentId: AgentId;
  path: string;
  status: "EXPOSED" | "PRESERVED_UNMANAGED" | "ERROR";
  mode?: TargetMode;
  error?: string;
}>;

export type AgentTargetFileSystem = Readonly<{
  copyDirectory: (source: string, destination: string) => Promise<void>;
  makeDirectory: (path: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
  symlinkDirectory: (target: string, path: string) => Promise<void>;
}>;

/** Filesystem adapter for local agent target exposure. */
export const localTargetFileSystem: AgentTargetFileSystem = {
  copyDirectory: (source, destination) =>
    cp(source, destination, { errorOnExist: true, recursive: true }),
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  move: rename,
  pathExists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
  remove: async (path) => {
    await rm(path, { force: true, recursive: true });
  },
  symlinkDirectory: (target, path) => symlink(target, path, "dir"),
};

export type ExposeInput = Readonly<{
  skillId: SkillId;
  skillName: string;
  canonicalPath: string;
  targets: AgentTargets;
  enabledAgentIds: readonly AgentId[];
  homeDir: string;
  ownership: TargetOwnership;
}>;

export type TargetOperationResult = Readonly<{
  ownership: TargetOwnership;
  outcomes: readonly TargetOutcome[];
}>;

/**
 * Resolves a skill's local targets. `all` is deliberately resolved at exposure
 * time, so agents enabled after a skill was added receive that skill too.
 */
export function applicableAgentIds(
  targets: AgentTargets,
  enabledAgentIds: readonly AgentId[],
): readonly AgentId[] {
  const allowed = new Set(targets === "all" ? enabledAgentIds : targets);
  return builtInAgentAdapters
    .map((adapter) => adapter.id)
    .filter(
      (id): id is AgentId => enabledAgentIds.includes(id) && allowed.has(id),
    );
}

/** Owns local agent exposure; callers persist the returned ownership separately. */
export class AgentTargetManager {
  constructor(
    private readonly fileSystem: AgentTargetFileSystem = localTargetFileSystem,
    private readonly adapters: readonly AgentAdapter[] = builtInAgentAdapters,
  ) {}

  async expose(input: ExposeInput): Promise<TargetOperationResult> {
    assertSkillName(input.skillName);
    const owned = new Map(
      input.ownership.map((target) => [ownershipKey(target), target]),
    );
    const outcomes: TargetOutcome[] = [];

    for (const agentId of applicableAgentIds(
      input.targets,
      input.enabledAgentIds,
    )) {
      const adapter = this.adapters.find(
        (candidate) => candidate.id === agentId,
      );
      if (!adapter) continue;
      for (const parent of adapter.globalSkillPaths(input.homeDir)) {
        const path = join(parent, input.skillName);
        const existing = owned.get(
          ownershipKey({ skillId: input.skillId, agentId, path }),
        );
        if ((await this.fileSystem.pathExists(path)) && !existing) {
          outcomes.push({ agentId, path, status: "PRESERVED_UNMANAGED" });
          continue;
        }

        try {
          if (existing) await this.fileSystem.remove(path);
          await this.fileSystem.makeDirectory(parent);
          const mode = await this.exposePath(input.canonicalPath, path);
          owned.set(ownershipKey({ skillId: input.skillId, agentId, path }), {
            skillId: input.skillId,
            agentId,
            path,
            canonicalPath: input.canonicalPath,
            mode,
          });
          outcomes.push({ agentId, path, status: "EXPOSED", mode });
        } catch (error) {
          outcomes.push({
            agentId,
            path,
            status: "ERROR",
            error:
              error instanceof Error
                ? error.message
                : "Target exposure failed.",
          });
        }
      }
    }

    return { ownership: sortOwnership([...owned.values()]), outcomes };
  }

  /** Removes ToolMirror ownership only; copied content remains an unmanaged skill. */
  async unmanage(
    skillId: SkillId,
    ownership: TargetOwnership,
  ): Promise<TargetOperationResult> {
    const remaining: ManagedTarget[] = [];
    const outcomes: TargetOutcome[] = [];
    for (const target of ownership) {
      if (target.skillId !== skillId) {
        remaining.push(target);
        continue;
      }

      try {
        if (
          target.mode === "symlink" &&
          (await this.fileSystem.pathExists(target.path))
        ) {
          await this.replaceSymlinkWithCopy(target.canonicalPath, target.path);
        }
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "EXPOSED",
          mode: "copy",
        });
      } catch (error) {
        remaining.push(target);
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "ERROR",
          error:
            error instanceof Error
              ? error.message
              : "Could not preserve target.",
        });
      }
    }
    return { ownership: sortOwnership(remaining), outcomes };
  }

  /** Removes only paths recorded as ToolMirror-owned. */
  async remove(
    skillId: SkillId,
    ownership: TargetOwnership,
    agentId?: AgentId,
  ): Promise<TargetOperationResult> {
    const remaining: ManagedTarget[] = [];
    const outcomes: TargetOutcome[] = [];
    for (const target of ownership) {
      if (
        target.skillId !== skillId ||
        (agentId && target.agentId !== agentId)
      ) {
        remaining.push(target);
        continue;
      }
      try {
        await this.fileSystem.remove(target.path);
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "EXPOSED",
        });
      } catch (error) {
        remaining.push(target);
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "ERROR",
          error:
            error instanceof Error ? error.message : "Could not remove target.",
        });
      }
    }
    return { ownership: sortOwnership(remaining), outcomes };
  }

  /** Disable is target removal restricted to one agent's recorded ownership. */
  disable(skillId: SkillId, agentId: AgentId, ownership: TargetOwnership) {
    return this.remove(skillId, ownership, agentId);
  }

  /** Restore re-exposes only recorded managed targets; unowned paths are untouched. */
  async restore(
    skillId: SkillId,
    canonicalPath: string,
    ownership: TargetOwnership,
  ): Promise<TargetOperationResult> {
    const retained = ownership.filter((target) => target.skillId !== skillId);
    const toRestore = ownership.filter((target) => target.skillId === skillId);
    const outcomes: TargetOutcome[] = [];
    const restored: ManagedTarget[] = [];

    for (const target of toRestore) {
      try {
        await this.fileSystem.remove(target.path);
        await this.fileSystem.makeDirectory(dirname(target.path));
        const mode = await this.exposePath(canonicalPath, target.path);
        restored.push({ ...target, mode });
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "EXPOSED",
          mode,
        });
      } catch (error) {
        restored.push(target);
        outcomes.push({
          agentId: target.agentId,
          path: target.path,
          status: "ERROR",
          error:
            error instanceof Error
              ? error.message
              : "Could not restore target.",
        });
      }
    }
    return { ownership: sortOwnership([...retained, ...restored]), outcomes };
  }

  private async exposePath(
    canonicalPath: string,
    path: string,
  ): Promise<TargetMode> {
    try {
      await this.fileSystem.symlinkDirectory(canonicalPath, path);
      return "symlink";
    } catch {
      await this.copyVerified(canonicalPath, path);
      return "copy";
    }
  }

  private async copyVerified(
    source: string,
    destination: string,
  ): Promise<void> {
    const expectedHash = await hashSkillDirectory(source);
    await this.fileSystem.copyDirectory(source, destination);
    if ((await hashSkillDirectory(destination)) !== expectedHash) {
      await this.fileSystem.remove(destination);
      throw new Error("Copy fallback did not match canonical skill content.");
    }
  }

  private async replaceSymlinkWithCopy(
    canonicalPath: string,
    path: string,
  ): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.unmanaged`;
    await this.copyVerified(canonicalPath, temporary);
    await this.fileSystem.remove(path);
    await this.fileSystem.move(temporary, path);
  }
}

function assertSkillName(skillName: string): void {
  if (
    skillName.length === 0 ||
    basename(skillName) !== skillName ||
    skillName === "."
  ) {
    throw new Error("Skill names must be a single path segment.");
  }
}

function ownershipKey(
  target: Pick<ManagedTarget, "skillId" | "agentId" | "path">,
): string {
  return `${target.skillId}\0${target.agentId}\0${target.path}`;
}

function sortOwnership(ownership: readonly ManagedTarget[]): TargetOwnership {
  return [...ownership].sort((left, right) =>
    ownershipKey(left).localeCompare(ownershipKey(right)),
  );
}
