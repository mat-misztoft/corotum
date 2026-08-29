import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId } from "../../core/src/index";
import type { AgentAdapter } from "./index";
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
  const root = await mkdtemp(join(tmpdir(), "toolmirror-targets-"));
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
  } as const;
}

describe("AgentTargetManager exposure", () => {
  test("targets all reaches an agent enabled after the skill was added", async () => {
    const { root, canonicalPath } = await fixture();
    const manager = new AgentTargetManager(localTargetFileSystem, adapters);
    const initial = await manager.expose(
      input(root, canonicalPath, "all", ["codex"]),
    );
    const later = await manager.expose(
      input(root, canonicalPath, "all", ["codex", "pi"], initial.ownership),
    );

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
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(
      "# Managed skill\n",
    );
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
      { agentId: "codex", path, status: "PRESERVED_UNMANAGED" },
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
