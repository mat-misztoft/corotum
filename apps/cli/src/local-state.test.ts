import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../../../packages/agent-targets/src/index";
import {
  type DesiredState,
  revisionId,
  skillId,
} from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import {
  LocalOperationalStateStore,
  managedTargetsFromState,
  recoverLocalOperationalState,
} from "./local-state";

const directories: string[] = [];
const id = skillId("sk_example");
const adapters: readonly AgentAdapter[] = [
  {
    id: "codex",
    name: "Codex",
    detectionPaths: () => [],
    globalSkillPaths: (home) => [join(home, "codex-skills")],
  },
];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corotum-local-state-"));
  directories.push(root);
  const skillsStoragePath = join(root, "skills");
  const canonicalPath = join(skillsStoragePath, "example");
  await mkdir(canonicalPath, { recursive: true });
  await writeFile(join(canonicalPath, "SKILL.md"), "# Example\n");
  const contentHash = await hashSkillDirectory(canonicalPath);
  const desired: DesiredState = {
    manifest: {
      version: 1,
      skills: [
        {
          id,
          source: "https://example.test/skills.git",
          skill: "example",
          ref: "main",
          targets: ["codex"],
          resolutionStatus: "RESOLVED",
        },
      ],
    },
    lockfile: {
      version: 1,
      skills: [
        {
          id,
          source: "https://example.test/skills.git",
          skill: "example",
          ref: "main",
          repository: "https://example.test/skills.git",
          revision: "abc123",
          path: "skills/example",
          contentHash,
        },
      ],
    },
  };
  return { root, skillsStoragePath, canonicalPath, contentHash, desired };
}

describe("LocalOperationalStateStore", () => {
  test("round-trips applied revision, hashes, canonical paths, and target ownership", async () => {
    const { root, canonicalPath, contentHash } = await fixture();
    const file = join(root, "state", "state.json");
    const store = new LocalOperationalStateStore(file);
    const state = {
      schemaVersion: 1 as const,
      lastAppliedRevision: revisionId("42"),
      skills: {
        [id]: {
          name: "example",
          canonicalPath,
          contentHash,
          targets: {
            codex: {
              agentId: "codex" as const,
              mode: "symlink" as const,
              path: join(root, "codex-skills", "example"),
              expectedHash: contentHash,
            },
          },
        },
      },
    };

    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      lastAppliedRevision: "42",
      schemaVersion: 1,
    });
    expect(managedTargetsFromState(state)).toEqual([
      {
        skillId: id,
        agentId: "codex",
        canonicalPath,
        mode: "symlink",
        path: join(root, "codex-skills", "example"),
        expectedHash: contentHash,
      },
    ]);
  });

  test("returns null for missing or corrupt state", async () => {
    const { root } = await fixture();
    const file = join(root, "state.json");
    const store = new LocalOperationalStateStore(file);
    expect(await store.load()).toBeNull();
    await writeFile(file, "not json");
    expect(await store.load()).toBeNull();
  });
});

describe("recoverLocalOperationalState", () => {
  test("recovers only hash-verified canonical copies and symlinks pointing to them", async () => {
    const { root, skillsStoragePath, canonicalPath, desired } = await fixture();
    const target = join(root, "codex-skills", "example");
    await mkdir(join(root, "codex-skills"), { recursive: true });
    await symlink(canonicalPath, target, "dir");

    const state = await recoverLocalOperationalState(
      {
        desired,
        lastAppliedRevision: revisionId("7"),
        skillsStoragePath,
        homeDir: root,
        enabledAgentIds: ["codex"],
      },
      adapters,
    );

    expect(state.lastAppliedRevision).toBe("7");
    expect(state.skills[id]?.canonicalPath).toBe(canonicalPath);
    expect(Object.values(state.skills[id]?.targets ?? {})).toEqual([
      { agentId: "codex", mode: "symlink", path: target, expectedHash: state.skills[id]?.contentHash },
    ]);
  });

  test("leaves ambiguous matching regular directories unmanaged", async () => {
    const { root, skillsStoragePath, canonicalPath, desired } = await fixture();
    const target = join(root, "codex-skills", "example");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# Example\n");

    const state = await recoverLocalOperationalState(
      {
        desired,
        lastAppliedRevision: null,
        skillsStoragePath,
        homeDir: root,
        enabledAgentIds: ["codex"],
      },
      adapters,
    );

    expect(state.skills[id]?.targets).toEqual({});
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
      "# Example\n",
    );
    expect(managedTargetsFromState(state)).toEqual([]);
    expect(canonicalPath).toBe(state.skills[id]?.canonicalPath);
  });

  test("does not recover a canonical directory whose content drifted", async () => {
    const { root, skillsStoragePath, canonicalPath, desired } = await fixture();
    await writeFile(join(canonicalPath, "SKILL.md"), "# Changed\n");

    const state = await recoverLocalOperationalState(
      {
        desired,
        lastAppliedRevision: null,
        skillsStoragePath,
        homeDir: root,
        enabledAgentIds: ["codex"],
      },
      adapters,
    );

    expect(state.skills).toEqual({});
  });
});
