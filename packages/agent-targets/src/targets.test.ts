import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId } from "../../core/src/index";
import type { AgentAdapter } from "./index";
import { hashSkillDirectory } from "../../skills-adapter/src/canonical-store";
import {
  type AgentTargetFileSystem,
  AgentTargetManager,
  localTargetFileSystem,
} from "./targets";

const directories: string[] = [];
const id = skillId("sk_target");
const adapters: readonly AgentAdapter[] = [
  {
    id: "codex",
    name: "Codex",
    detectionPaths: () => [],
    globalSkillPaths: (home) => [join(home, "codex-skills")],
  },
  {
    id: "pi",
    name: "Pi",
    detectionPaths: () => [],
    globalSkillPaths: (home) => [join(home, "pi-skills")],
  },
];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corotum-targets-"));
  directories.push(root);
  const canonicalPath = join(root, "canonical");
  await mkdir(canonicalPath);
  await writeFile(join(canonicalPath, "SKILL.md"), "# Managed skill\n");
  return { root, canonicalPath };
}

function input(
  root: string,
  canonicalPath: string,
  targets: "all" | readonly string[],
  enabledAgentIds: readonly ("codex" | "pi")[],
  ownership = [],
) {
  return {
    skillId: id,
    skillName: "example",
    canonicalPath,
    targets,
    enabledAgentIds,
    homeDir: root,
    ownership,
    expectedContentHash: "sha256:expected",
  } as const;
}

describe("AgentTargetManager exposure", () => {
  test("targets all reaches an agent enabled after the skill was added", async () => {
    const { root, canonicalPath } = await fixture();
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);
    const expectedContentHash = await hashSkillDirectory(canonicalPath);
    const initial = await manager.expose({
      ...input(root, canonicalPath, "all", ["codex"]),
      expectedContentHash,
    });
    const later = await manager.expose({
      ...input(root, canonicalPath, "all", ["codex", "pi"], initial.ownership),
      expectedContentHash,
    });

    expect(later.ownership.map((target) => target.agentId)).toEqual([
      "codex",
      "pi",
    ]);
    expect(
      await readFile(join(root, "pi-skills", "example", "SKILL.md"), "utf8"),
    ).toBe("# Managed skill\n");
  });

  test("explicit targets reach only enabled named agents", async () => {
    const { root, canonicalPath } = await fixture();
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);
    const result = await manager.expose(
      input(root, canonicalPath, ["pi"], ["codex", "pi"]),
    );

    expect(result.ownership.map((target) => target.agentId)).toEqual(["pi"]);
    expect(
      await localTargetFileSystem.pathExists(
        join(root, "codex-skills", "example"),
      ),
    ).toBe(false);
  });

  test("falls back to a verified copy when symlinks are unavailable", async () => {
    const { root, canonicalPath } = await fixture();
    const noSymlink: AgentTargetFileSystem = {
      ...localTargetFileSystem,
      symlinkDirectory: async () => {
        throw new Error("Symlinks unavailable");
      },
    };
    const manager = new AgentTargetManager(noSymlink, adapters);
    const result = await manager.expose(
      input(root, canonicalPath, ["codex"], ["codex"]),
    );
    const path = join(root, "codex-skills", "example");

    expect(result.ownership[0]?.mode).toBe("copy");
    expect(result.ownership[0]?.expectedHash).toBe(await hashSkillDirectory(path));
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(
      "# Managed skill\n",
    );
  });

  test("recreates a missing recorded target", async () => {
    const { root, canonicalPath } = await fixture();
    const hash = await hashSkillDirectory(canonicalPath);
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);
    const initial = await manager.expose({
      ...input(root, canonicalPath, ["codex"], ["codex"]),
      expectedContentHash: hash,
    });
    const path = join(root, "codex-skills", "example");
    await rm(path, { force: true, recursive: true });

    const repaired = await manager.expose({
      ...input(root, canonicalPath, ["codex"], ["codex"], initial.ownership),
      expectedContentHash: hash,
    });

    expect(repaired.outcomes).toEqual([
      { agentId: "codex", path, status: "EXPOSED", mode: "symlink" },
    ]);
    expect(await realpath(path)).toBe(await realpath(canonicalPath));
  });

  test("repoints a verified owned symlink to the named canonical directory", async () => {
    const { root, canonicalPath: oldCanonicalPath } = await fixture();
    const namedCanonicalPath = join(root, "agents", "skills", "example");
    await mkdir(join(root, "agents", "skills"), { recursive: true });
    await writeFile(join(oldCanonicalPath, "SKILL.md"), "# Previous skill\n");
    await mkdir(namedCanonicalPath);
    await writeFile(join(namedCanonicalPath, "SKILL.md"), "# Managed skill\n");
    const path = join(root, "codex-skills", "example");
    await mkdir(join(root, "codex-skills"), { recursive: true });
    await symlink(oldCanonicalPath, path, "dir");
    const oldHash = await hashSkillDirectory(oldCanonicalPath);
    const newHash = await hashSkillDirectory(namedCanonicalPath);
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);

    const result = await manager.expose({
      ...input(root, namedCanonicalPath, ["codex"], ["codex"]),
      expectedContentHash: newHash,
      ownership: [{
        skillId: id,
        agentId: "codex",
        path,
        canonicalPath: oldCanonicalPath,
        mode: "symlink",
        expectedHash: oldHash,
      }],
    });

    expect(result.outcomes).toEqual([{ agentId: "codex", path, status: "EXPOSED", mode: "symlink" }]);
    expect(await realpath(path)).toBe(await realpath(namedCanonicalPath));
  });

  test("restores a verified target when exposure replacement fails", async () => {
    const { root, canonicalPath } = await fixture();
    const path = join(root, "codex-skills", "example");
    const hash = await hashSkillDirectory(canonicalPath);
    const initial = await new AgentTargetManager(localTargetFileSystem, adapters).expose({
      ...input(root, canonicalPath, ["codex"], ["codex"]),
      expectedContentHash: hash,
    });
    const failingMove: AgentTargetFileSystem = {
      ...localTargetFileSystem,
      move: async (from, to) => {
        if (from.includes(".staging") && to === path) throw new Error("replacement failed");
        await localTargetFileSystem.move(from, to);
      },
    };

    const result = await new AgentTargetManager(failingMove, adapters).expose({
      ...input(root, canonicalPath, ["codex"], ["codex"], initial.ownership),
      expectedContentHash: hash,
    });

    expect(result.outcomes[0]?.status).toBe("ERROR");
    expect(await realpath(path)).toBe(await realpath(canonicalPath));
    expect((await readdir(join(root, "codex-skills"))).some((name) => name.includes(".staging") || name.includes(".backup"))).toBe(false);
  });

  test("never changes an unowned target during enable, disable, remove, unmanage, or restore", async () => {
    const { root, canonicalPath } = await fixture();
    const path = join(root, "codex-skills", "example");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "# Unmanaged\n");
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);

    const enabled = await manager.expose(
      input(root, canonicalPath, ["codex"], ["codex"]),
    );
    expect(enabled.outcomes).toEqual([
      { agentId: "codex", path, status: "LOCAL_CONFLICT" },
    ]);
    const disabled = await manager.disable(id, "codex", enabled.ownership);
    const removed = await manager.remove(id, disabled.ownership);
    const unmanaged = await manager.unmanage(id, removed.ownership);
    await manager.restore(id, canonicalPath, unmanaged.ownership);

    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(
      "# Unmanaged\n",
    );
  });

  test("unmanage turns a managed symlink into an unmanaged copy", async () => {
    const { root, canonicalPath } = await fixture();
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);
    const exposed = await manager.expose(
      input(root, canonicalPath, ["codex"], ["codex"]),
    );
    const path = join(root, "codex-skills", "example");

    const unmanaged = await manager.unmanage(id, exposed.ownership);
    expect(unmanaged.ownership).toEqual([]);
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(
      "# Managed skill\n",
    );
  });
});
