import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DesiredState,
  LockedSkill,
  ReconcilePlan,
  SkillId,
} from "../../../packages/core/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import {
  type LocalOperationalState,
  LocalOperationalStateStore,
} from "./local-state";
import { LocalReconcileExecutor } from "./reconcile-executor";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  ),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corotum-executor-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "exact locked bytes\n");
  const contentHash = await hashSkillDirectory(source);
  const id = "sk_executor" as SkillId;
  const lock = {
    id,
    source: "https://example.test/skills.git",
    skill: "example",
    ref: "main",
    repository: "https://example.test/skills.git",
    revision: "a".repeat(40),
    path: "example",
    contentHash,
  } as LockedSkill;
  const desired = {
    manifest: {
      version: 1,
      skills: [
        {
          id,
          source: lock.source,
          skill: lock.skill,
          ref: lock.ref,
          targets: [],
        },
      ],
    },
    lockfile: { version: 1, skills: [lock] },
  } as DesiredState;
  const state: LocalOperationalState = {
    schemaVersion: 1,
    lastAppliedRevision: null,
    skills: {},
  };
  return { root, source, lock, desired, state };
}

describe("LocalReconcileExecutor", () => {
  test("installs exact locked content and persists ownership only after verification", async () => {
    const { root, source, lock, desired, state } = await fixture();
    const materializer = {
      materialize: async (_lock: LockedSkill, destination: string) => {
        await mkdir(destination);
        await writeFile(
          join(destination, "SKILL.md"),
          await readFile(join(source, "SKILL.md")),
        );
      },
    };
    const targets = {
      expose: async (input: { skillId: SkillId; canonicalPath: string }) => ({
        ownership: [
          {
            skillId: input.skillId,
            agentId: "pi",
            path: join(root, "pi", "example"),
            canonicalPath: input.canonicalPath,
            mode: "symlink" as const,
            expectedHash: lock.contentHash,
          },
        ],
        outcomes: [
          {
            agentId: "pi",
            path: join(root, "pi", "example"),
            status: "EXPOSED" as const,
            mode: "symlink" as const,
          },
        ],
      }),
    };
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      materializer as never,
      targets as never,
    );
    const plan: ReconcilePlan = {
      classifications: [],
      operations: [{ kind: "INSTALL", skill: lock }],
    };

    const result = await executor.execute({
      plan,
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });

    expect(result.operations[0]).toMatchObject({
      status: "SUCCESS",
      targetOutcomes: [{ status: "EXPOSED" }],
    });
    expect(result.state.skills[lock.id]?.contentHash).toBe(lock.contentHash);
    expect(result.state.lastAppliedRevision).toBe("1");
    expect(await hashSkillDirectory(join(root, "canonical", lock.skill))).toBe(
      lock.contentHash,
    );
  });

  test("offline unmanage preserves canonical content and converts verified symlinks to copies", async () => {
    const { root, lock, desired } = await fixture();
    const canonicalPath = join(root, "canonical", lock.skill);
    const targetPath = join(root, "pi", lock.skill);
    await mkdir(canonicalPath, { recursive: true });
    await writeFile(join(canonicalPath, "SKILL.md"), "exact locked bytes\n");
    await mkdir(join(root, "pi"));
    await symlink(canonicalPath, targetPath);
    const state: LocalOperationalState = {
      schemaVersion: 2,
      lastAppliedRevision: "0" as never,
      skills: {
        [lock.id]: {
          name: lock.skill,
          canonicalPath,
          contentHash: lock.contentHash,
          targets: {
            [`pi\0${targetPath}`]: {
              agentId: "pi",
              mode: "symlink",
              path: targetPath,
              expectedHash: lock.contentHash,
            },
          },
        },
      },
    };
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
    );
    const result = await executor.execute({
      plan: {
        classifications: [],
        operations: [{ kind: "UNMANAGE", skillId: lock.id }],
      },
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });
    expect(result.operations[0]?.status).toBe("SUCCESS");
    expect(result.state.skills[lock.id]).toBeUndefined();
    expect((await lstat(targetPath)).isSymbolicLink()).toBeFalse();
    expect(await hashSkillDirectory(canonicalPath)).toBe(lock.contentHash);
    expect(await hashSkillDirectory(targetPath)).toBe(lock.contentHash);
  });

  test("offline remove deletes verified ownership and continues with unrelated installs", async () => {
    const { root, source, lock, desired } = await fixture();
    const removedId = "sk_removed" as SkillId;
    const removedPath = join(root, "canonical", "removed");
    await mkdir(removedPath, { recursive: true });
    await writeFile(join(removedPath, "SKILL.md"), "exact locked bytes\n");
    const state: LocalOperationalState = {
      schemaVersion: 2,
      lastAppliedRevision: "0" as never,
      skills: {
        [removedId]: {
          name: "removed",
          canonicalPath: removedPath,
          contentHash: lock.contentHash,
          targets: {},
        },
      },
    };
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      {
        materialize: async (_lock: LockedSkill, destination: string) => {
          await mkdir(destination);
          await writeFile(
            join(destination, "SKILL.md"),
            await readFile(join(source, "SKILL.md")),
          );
        },
      } as never,
      {
        remove: async () => ({ ownership: [], outcomes: [] }),
        expose: async () => ({ ownership: [], outcomes: [] }),
      } as never,
    );
    const result = await executor.execute({
      plan: {
        classifications: [],
        operations: [
          { kind: "REMOVE", skillId: removedId },
          { kind: "INSTALL", skill: lock },
        ],
      },
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });
    expect(result.operations.map(({ status }) => status)).toEqual([
      "SUCCESS",
      "SUCCESS",
    ]);
    expect(await Bun.file(removedPath).exists()).toBeFalse();
    expect(await hashSkillDirectory(join(root, "canonical", lock.skill))).toBe(
      lock.contentHash,
    );
  });

  test("does not advance the applied revision while a local collision is unresolved", async () => {
    const { root, source, lock, desired, state } = await fixture();
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      {
        materialize: async (_lock: LockedSkill, destination: string) => {
          await mkdir(destination);
          await writeFile(
            join(destination, "SKILL.md"),
            await readFile(join(source, "SKILL.md")),
          );
        },
      } as never,
      { expose: async () => ({ ownership: [], outcomes: [] }) } as never,
    );

    const result = await executor.execute({
      plan: {
        classifications: [
          {
            skillId: "sk_collision" as SkillId,
            classification: "LOCAL_CONFLICT",
          },
        ],
        operations: [{ kind: "INSTALL", skill: lock }],
      },
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });

    expect(result.operations[0]?.status).toBe("SUCCESS");
    expect(result.state.lastAppliedRevision).toBeNull();
  });

  test("does not treat an unmanaged target collision as a successful install", async () => {
    const { root, lock, desired, state } = await fixture();
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      {
        materialize: async (_lock: LockedSkill, destination: string) => {
          await mkdir(destination);
          await writeFile(
            join(destination, "SKILL.md"),
            "exact locked bytes\n",
          );
        },
      } as never,
      {
        expose: async () => ({
          ownership: [],
          outcomes: [
            {
              agentId: "pi",
              path: join(root, "pi", lock.skill),
              status: "LOCAL_CONFLICT" as const,
            },
          ],
        }),
      } as never,
    );

    const result = await executor.execute({
      plan: {
        classifications: [],
        operations: [{ kind: "INSTALL", skill: lock }],
      },
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });

    expect(result.operations[0]).toMatchObject({
      status: "ERROR",
      error: `Unmanaged target collision at ${join(root, "pi", lock.skill)}.`,
    });
    expect(result.state.lastAppliedRevision).toBeNull();
  });

  test("does not advance the applied revision while another skill is drifted", async () => {
    const { root, source, lock, desired, state } = await fixture();
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      {
        materialize: async (_lock: LockedSkill, destination: string) => {
          await mkdir(destination);
          await writeFile(
            join(destination, "SKILL.md"),
            await readFile(join(source, "SKILL.md")),
          );
        },
      } as never,
      {
        expose: async () => ({ ownership: [], outcomes: [] }),
      } as never,
    );

    const result = await executor.execute({
      plan: {
        classifications: [
          { skillId: "sk_drifted" as SkillId, classification: "DRIFTED" },
        ],
        operations: [{ kind: "INSTALL", skill: lock }],
      },
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });

    expect(result.state.lastAppliedRevision).toBeNull();
  });

  test("continues after a source failure and retains target-level errors", async () => {
    const { root, lock, desired, state } = await fixture();
    const failedId = "sk_failed" as SkillId;
    const failed = { ...lock, id: failedId, skill: "failed" } as LockedSkill;
    const materializer = {
      materialize: async (item: LockedSkill, destination: string) => {
        if (item.id === failedId) throw new Error("source unavailable");
        await mkdir(destination);
        await writeFile(join(destination, "SKILL.md"), "exact locked bytes\n");
      },
    };
    const targets = {
      expose: async (_input: { skillId: SkillId; canonicalPath: string }) => ({
        ownership: [],
        outcomes: [
          {
            agentId: "pi",
            path: "target",
            status: "ERROR" as const,
            error: "read-only target",
          },
        ],
      }),
    };
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "state.json")),
      new CanonicalSkillStore(join(root, "canonical")),
      materializer as never,
      targets as never,
    );
    const plan: ReconcilePlan = {
      classifications: [],
      operations: [
        { kind: "INSTALL", skill: failed },
        { kind: "INSTALL", skill: lock },
      ],
    };

    const result = await executor.execute({
      plan,
      desired,
      revision: "1" as never,
      state,
      enabledAgentIds: [],
      homeDir: root,
    });

    expect(result.operations).toEqual([
      expect.objectContaining({
        skillId: failedId,
        status: "ERROR",
        error: "source unavailable",
      }),
      expect.objectContaining({
        skillId: lock.id,
        status: "ERROR",
        targetOutcomes: [
          expect.objectContaining({ error: "read-only target" }),
        ],
      }),
    ]);
    expect(result.state.skills[lock.id]?.contentHash).toBe(lock.contentHash);
  });
});
