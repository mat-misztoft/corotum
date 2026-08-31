import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(await hashSkillDirectory(join(root, "canonical", lock.id))).toBe(
      lock.contentHash,
    );
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
