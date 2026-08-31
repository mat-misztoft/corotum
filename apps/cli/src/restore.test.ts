import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { revisionId, skillId } from "../../../packages/core/src/index";
import { findRestoreConflicts, RestoreService } from "./restore";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  ),
);

const id = skillId("sk_restore");
const lock = {
  id,
  source: "https://example.test/skills.git",
  skill: "restore",
  ref: "main",
  repository: "https://example.test/skills.git",
  revision: "a".repeat(40),
  path: "restore",
  contentHash: "sha256:locked",
} as const;
const desired = {
  manifest: {
    version: 1 as const,
    skills: [
      {
        id,
        source: lock.source,
        skill: lock.skill,
        ref: lock.ref,
        targets: [] as const,
        resolutionStatus: "RESOLVED" as const,
      },
    ],
  },
  lockfile: { version: 1 as const, skills: [lock] },
};
const state = {
  schemaVersion: 1 as const,
  lastAppliedRevision: revisionId("base"),
  skills: {
    [id]: {
      canonicalPath: "/store/restore",
      contentHash: "sha256:drifted",
      targets: {},
    },
  },
};

function fixture() {
  const executed: unknown[] = [];
  const provider = {
    pull: async () => ({
      kind: "success" as const,
      value: { revisionId: revisionId("locked"), state: desired },
    }),
  };
  const executor = {
    execute: async (input: unknown) => {
      executed.push(input);
      return { state, operations: [{ status: "SUCCESS" }] };
    },
  };
  return { executed, service: new RestoreService(provider, executor) };
}

const execution = {
  enabledAgentIds: [] as const,
  homeDir: "/home/test",
  state,
};

describe("CLI restore", () => {
  test("restores exactly one managed lock locally without changing desired state", async () => {
    const { service, executed } = fixture();
    await expect(
      service.restore({ name: "restore", all: false, execution }),
    ).resolves.toEqual({ kind: "restored", skills: [id] });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      desired,
      revision: revisionId("locked"),
      plan: { operations: [{ kind: "INSTALL", skill: lock }] },
    });
  });

  test("restore all schedules every exact locked skill and reports partial repairs", async () => {
    const { service } = fixture();
    const partial = new RestoreService(
      {
        pull: async () => ({
          kind: "success" as const,
          value: { revisionId: revisionId("locked"), state: desired },
        }),
      },
      { execute: async () => ({ state, operations: [{ status: "ERROR" }] }) },
    );
    await expect(
      partial.restore({ all: true, execution }),
    ).resolves.toMatchObject({ kind: "partial", skills: [id] });
    await expect(
      service.restore({ all: false, execution }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Specify a skill"),
    });
  });

  test("refuses an untracked target and a replaced managed symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-restore-"));
    roots.push(root);
    const canonical = join(root, "canonical");
    const target = join(root, ".pi", "agent", "skills", "restore");
    await mkdir(join(root, ".pi", "agent", "skills"), { recursive: true });
    await mkdir(target);
    await expect(
      findRestoreConflicts({
        desired: {
          ...desired,
          manifest: {
            ...desired.manifest,
            skills: [{ ...desired.manifest.skills[0], targets: ["pi"] }],
          },
        },
        locks: [lock],
        state: { ...state, skills: {} },
        enabledAgentIds: ["pi"],
        homeDir: root,
      }),
    ).resolves.toContain("Unmanaged target");

    await rm(target, { recursive: true });
    await mkdir(canonical);
    await symlink(join(root, "other"), target, "dir");
    await expect(
      findRestoreConflicts({
        desired,
        locks: [lock],
        state: {
          ...state,
          skills: {
            [id]: {
              ...state.skills[id],
              canonicalPath: canonical,
              targets: {
                target: { agentId: "pi", mode: "symlink", path: target },
              },
            },
          },
        },
        enabledAgentIds: [],
        homeDir: root,
      }),
    ).resolves.toContain("was replaced");
  });
});
