import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId } from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import {
  LEGACY_MIGRATION_MARKER,
  LegacyMigrationError,
  LegacyMigrator,
} from "./legacy-migration";
import {
  resolveLegacyPlatformPaths,
  resolvePlatformPaths,
  type CorotumPaths,
} from "./platform";

const directories: string[] = [];
const id = skillId("sk_example");
const revision = "a".repeat(40);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corotum-legacy-"));
  directories.push(root);
  return root;
}

function env(homeDir: string, platform: "darwin" | "linux" | "win32" = "linux") {
  return {
    homeDir,
    platform,
    env:
      platform === "win32"
        ? { APPDATA: join(homeDir, "Roaming"), LOCALAPPDATA: join(homeDir, "Local") }
        : undefined,
  };
}

async function writeSkill(root: string, content = "# Example\n"): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), content);
  return hashSkillDirectory(root);
}

async function seedLegacy(homeDir: string, paths: { legacy: CorotumPaths; current: CorotumPaths }, options?: {
  extraUnmanaged?: boolean;
  collidingName?: boolean;
  copyTarget?: boolean;
}) {
  const legacySkill = join(paths.legacy.skillsDir, id);
  const hash = await writeSkill(legacySkill);
  await mkdir(join(paths.legacy.gitDir, "cache"), { recursive: true });
  await writeFile(
    join(paths.legacy.gitDir, "cache", "toolmirror.yaml"),
    `version: 1\nskills:\n  - id: ${id}\n    source: https://example.test/skills.git\n    skill: example\n    ref: main\n    targets:\n      - codex\n`,
  );
  await writeFile(
    join(paths.legacy.gitDir, "cache", "toolmirror.lock"),
    `${JSON.stringify({
      version: 1,
      skills: [{
        id,
        source: "https://example.test/skills.git",
        skill: "example",
        ref: "main",
        repository: "https://example.test/skills.git",
        revision,
        path: "example",
        contentHash: hash,
      }],
    }, null, 2)}\n`,
  );
  await writeFile(
    join(paths.legacy.gitDir, "cache", "toolmirror.transition.json"),
    `${JSON.stringify({ type: "ADD", skillId: id, metadata: {} })}\n`,
  );
  await mkdir(paths.legacy.configDir, { recursive: true });
  await mkdir(paths.legacy.stateDir, { recursive: true });
  await writeFile(
    paths.legacy.configFile,
    `${JSON.stringify({
      schemaVersion: 1,
      mode: "git",
      workspaceId: null,
      deviceId: null,
      skillsStoragePath: paths.legacy.skillsDir,
      gitStoragePath: null,
      gitRepository: "https://example.test/skills.git",
      telemetry: false,
      installationId: null,
      agents: { codex: { enabled: true } },
    }, null, 2)}\n`,
  );
  const targetParent = join(homeDir, ".codex", "skills");
  await mkdir(targetParent, { recursive: true });
  const targetPath = join(targetParent, "example");
  if (options?.copyTarget) await writeSkill(targetPath, "# Example\n");
  else await symlink(legacySkill, targetPath, "dir");
  await writeFile(
    join(paths.legacy.stateDir, "state.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      lastAppliedRevision: revision,
      skills: {
        [id]: {
          name: "example",
          canonicalPath: legacySkill,
          contentHash: hash,
          ownership: "verified",
          targets: {
            [`codex\0${targetPath}`]: {
              agentId: "codex",
              mode: options?.copyTarget ? "copy" : "symlink",
              path: targetPath,
              expectedHash: hash,
            },
          },
        },
      },
    }, null, 2)}\n`,
  );
  if (options?.extraUnmanaged) await writeSkill(join(paths.legacy.skillsDir, "sk_unmanaged"), "# Other\n");
  if (options?.collidingName) {
    await mkdir(paths.current.skillsDir, { recursive: true });
    await writeSkill(join(paths.current.skillsDir, "example"), "# Collision\n");
  }
  return { hash, targetPath, legacySkill };
}

describe("legacy platform paths", () => {
  test("resolves Corotum roots and ToolMirror backups including Windows fixtures", () => {
    expect(resolvePlatformPaths({ homeDir: "/Users/alex", platform: "darwin" })).toMatchObject({
      configDir: "/Users/alex/Library/Application Support/Corotum",
      skillsDir: "/Users/alex/.agents/skills",
    });
    expect(resolveLegacyPlatformPaths({ homeDir: "/Users/alex", platform: "darwin" })).toMatchObject({
      configDir: "/Users/alex/Library/Application Support/ToolMirror",
      skillsDir: "/Users/alex/Library/Application Support/ToolMirror/skills",
    });
    expect(
      resolvePlatformPaths({
        homeDir: "C:\\Users\\alex",
        platform: "win32",
        env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" },
      }),
    ).toMatchObject({
      configDir: "C:\\Roaming/Corotum",
      dataDir: "C:\\Local/Corotum",
      skillsDir: "C:\\Users\\alex/.agents/skills",
    });
    expect(
      resolveLegacyPlatformPaths({
        homeDir: "C:\\Users\\alex",
        platform: "win32",
        env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" },
      }),
    ).toMatchObject({
      configDir: "C:\\Roaming/ToolMirror",
      dataDir: "C:\\Local/ToolMirror",
      skillsDir: "C:\\Local/ToolMirror/skills",
    });
  });
});

describe("legacy ToolMirror migration", () => {
  test("discovers old roots and files, stages named skills, retargets, then writes Corotum state", async () => {
    const homeDir = await home();
    const current = resolvePlatformPaths(env(homeDir, "darwin"));
    const legacy = resolveLegacyPlatformPaths(env(homeDir, "darwin"));
    const seeded = await seedLegacy(homeDir, { current, legacy });
    const migrator = new LegacyMigrator();

    const discovered = await migrator.discover({ current, legacy });
    expect(discovered.roots).toContain(legacy.configDir);
    expect(discovered.skillDirs).toContain(seeded.legacySkill);
    expect(discovered.files.some((file) => file.endsWith("toolmirror.yaml"))).toBe(true);
    expect(discovered.files.some((file) => file.endsWith("toolmirror.lock"))).toBe(true);
    expect(discovered.files.some((file) => file.endsWith("toolmirror.transition.json"))).toBe(true);

    const result = await migrator.migrate({ homeDir, current, legacy });
    expect(result.conflicts).toEqual([]);
    expect(await readFile(join(current.skillsDir, "example", "SKILL.md"), "utf8")).toBe("# Example\n");
    expect(await hashSkillDirectory(join(current.skillsDir, "example"))).toBe(seeded.hash);
    expect((await lstat(seeded.targetPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(current.configDir, "config.json"), "utf8")).toContain("git");
    expect(JSON.parse(await readFile(join(current.stateDir, "state.json"), "utf8")).skills[id].canonicalPath)
      .toBe(join(current.skillsDir, "example"));
    expect(await readFile(join(current.gitDir, "cache", "corotum.yaml"), "utf8")).toContain("version: 2");
    expect(await readFile(join(current.gitDir, "cache", "corotum.lock"), "utf8")).toContain(id);
    expect(await existsPath(seeded.legacySkill)).toBe(true);
    expect(await existsPath(legacy.configFile)).toBe(true);

    const again = await migrator.migrate({ homeDir, current, legacy });
    expect(again.marker.status).toBe("state-updated");
  });

  test("re-verifies copy fallback and reports colliding or unmanaged content as LOCAL_CONFLICT", async () => {
    const homeDir = await home();
    const current = resolvePlatformPaths(env(homeDir));
    const legacy = resolveLegacyPlatformPaths(env(homeDir));
    const seeded = await seedLegacy(homeDir, { current, legacy }, { extraUnmanaged: true, copyTarget: true });
    const result = await new LegacyMigrator().migrate({ homeDir, current, legacy });
    expect(result.conflicts.some((conflict) => conflict.path.endsWith("sk_unmanaged"))).toBe(true);
    expect(await readFile(join(legacy.skillsDir, "sk_unmanaged", "SKILL.md"), "utf8")).toBe("# Other\n");
    await new LegacyMigrator().cleanup({ current });
    expect(await readFile(join(legacy.skillsDir, "sk_unmanaged", "SKILL.md"), "utf8")).toBe("# Other\n");
    expect(result.marker.skills[0]?.targets[0]?.mode).toBe("copy");
    expect(await hashSkillDirectory(seeded.targetPath)).toBe(seeded.hash);

    const collidingHome = await home();
    const collidingCurrent = resolvePlatformPaths(env(collidingHome));
    const collidingLegacy = resolveLegacyPlatformPaths(env(collidingHome));
    await seedLegacy(collidingHome, { current: collidingCurrent, legacy: collidingLegacy }, { collidingName: true });
    const colliding = await new LegacyMigrator().migrate({
      homeDir: collidingHome,
      current: collidingCurrent,
      legacy: collidingLegacy,
    });
    expect(colliding.conflicts.some((conflict) => conflict.code === "LOCAL_CONFLICT")).toBe(true);
    expect(await readFile(join(collidingCurrent.skillsDir, "example", "SKILL.md"), "utf8")).toBe("# Collision\n");
  });

  test("recovers after copy or state failure and refuses or retries cleanup", async () => {
    const homeDir = await home();
    const current = resolvePlatformPaths(env(homeDir));
    const legacy = resolveLegacyPlatformPaths(env(homeDir));
    const seeded = await seedLegacy(homeDir, { current, legacy });

    const copyFail = new LegacyMigrator({
      copyDirectory: async () => {
        throw new Error("copy failed");
      },
    });
    await expect(copyFail.migrate({ homeDir, current, legacy })).rejects.toThrow("copy failed");
    expect(await existsPath(seeded.legacySkill)).toBe(true);
    expect(await existsPath(join(current.skillsDir, "example"))).toBe(false);

    let afterCopy = 0;
    const failAfterCopy = new LegacyMigrator({
      afterCopy: async () => {
        afterCopy += 1;
        if (afterCopy === 1) throw new Error("after copy");
      },
    });
    await expect(failAfterCopy.migrate({ homeDir, current, legacy })).rejects.toThrow("after copy");
    expect(await existsPath(seeded.legacySkill)).toBe(true);
    expect(JSON.parse(await readFile(join(current.stateDir, LEGACY_MIGRATION_MARKER), "utf8")).status).toBe("copied");

    const resumed = await failAfterCopy.migrate({ homeDir, current, legacy });
    expect(resumed.marker.status).toBe("state-updated");

    const afterStateHome = await home();
    const afterStateCurrent = resolvePlatformPaths(env(afterStateHome));
    const afterStateLegacy = resolveLegacyPlatformPaths(env(afterStateHome));
    await seedLegacy(afterStateHome, { current: afterStateCurrent, legacy: afterStateLegacy });
    let afterState = 0;
    const failAfterState = new LegacyMigrator({
      afterState: async () => {
        afterState += 1;
        if (afterState === 1) throw new Error("after state");
      },
    });
    await expect(failAfterState.migrate({
      homeDir: afterStateHome,
      current: afterStateCurrent,
      legacy: afterStateLegacy,
    })).rejects.toThrow("after state");
    expect(await existsPath(afterStateLegacy.configFile)).toBe(true);
    const recovered = await failAfterState.migrate({
      homeDir: afterStateHome,
      current: afterStateCurrent,
      legacy: afterStateLegacy,
    });
    expect(recovered.marker.status).toBe("state-updated");

    const cleanupHome = await home();
    const cleanupCurrent = resolvePlatformPaths(env(cleanupHome));
    const cleanupLegacy = resolveLegacyPlatformPaths(env(cleanupHome));
    const cleanupSeed = await seedLegacy(cleanupHome, { current: cleanupCurrent, legacy: cleanupLegacy });
    const migrator = new LegacyMigrator();
    await expect(migrator.cleanup({ current: cleanupCurrent })).rejects.toBeInstanceOf(LegacyMigrationError);
    await mkdir(cleanupCurrent.stateDir, { recursive: true });
    await writeFile(join(cleanupCurrent.stateDir, LEGACY_MIGRATION_MARKER), "{not-json");
    await expect(migrator.cleanup({ current: cleanupCurrent })).rejects.toThrow("corrupt");
    await rm(join(cleanupCurrent.stateDir, LEGACY_MIGRATION_MARKER), { force: true });
    await migrator.migrate({ homeDir: cleanupHome, current: cleanupCurrent, legacy: cleanupLegacy });
    await mkdir(cleanupCurrent.stateDir, { recursive: true });
    await writeFile(join(cleanupCurrent.stateDir, `${LEGACY_MIGRATION_MARKER}.extra`), "{}");
    await expect(migrator.cleanup({ current: cleanupCurrent })).rejects.toThrow("ambiguous");
    await rm(join(cleanupCurrent.stateDir, `${LEGACY_MIGRATION_MARKER}.extra`));
    const pending = JSON.parse(await readFile(join(cleanupCurrent.stateDir, LEGACY_MIGRATION_MARKER), "utf8")) as { backups: string[] };
    await rm(pending.backups[0] as string, { force: true, recursive: true });
    const cleaned = await migrator.cleanup({ current: cleanupCurrent });
    expect(cleaned.status).toBe("cleaned");
    expect(await existsPath(cleanupSeed.legacySkill)).toBe(false);
    expect(await existsPath(join(cleanupCurrent.skillsDir, "example"))).toBe(true);
    expect(await existsPath(cleanupLegacy.configFile)).toBe(false);
    const retried = await migrator.cleanup({ current: cleanupCurrent });
    expect(retried.status).toBe("cleaned");
  });
});

async function existsPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
