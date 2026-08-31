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

import { ConfigStore } from "./config";
import type { CorotumPaths } from "./platform";
import { SkillsStorageMigrator } from "./skills-storage-migration";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture(): Promise<CorotumPaths> {
  const root = await mkdtemp(join(tmpdir(), "corotum-skills-migration-"));
  temporaryDirectories.push(root);
  return {
    configDir: join(root, "config"),
    configFile: join(root, "config", "config.json"),
    credentialsFile: join(root, "config", "credentials.json"),
    dataDir: join(root, "data"),
    gitDir: join(root, "data", "git"),
    runtimeDir: join(root, "runtime"),
    skillsDir: join(root, "data", "skills"),
    stateDir: join(root, "state"),
  };
}

async function addSkill(root: string, content = "# Skill\n"): Promise<void> {
  const skill = join(root, "sk_example");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), content);
}

describe("skills storage migration", () => {
  test("moves verified canonical bytes before persisting config and is safe to repeat", async () => {
    const paths = await fixture();
    await addSkill(paths.skillsDir);
    const destination = join(paths.dataDir, "relocated-skills");
    const config = new ConfigStore(paths);

    await config.set("skillsStoragePath", destination);

    expect(
      await readFile(join(destination, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
    await expect(lstat(paths.skillsDir)).rejects.toThrow();
    expect((await config.list()).skillsStoragePath).toBe(destination);

    await config.set("skillsStoragePath", destination);
    expect(
      await readFile(join(destination, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
  });

  test("copy failure preserves the original storage and config", async () => {
    const paths = await fixture();
    await addSkill(paths.skillsDir);
    const config = new ConfigStore(
      paths,
      new SkillsStorageMigrator(undefined, async () => {
        throw new Error("copy failed");
      }),
    );

    await expect(
      config.set("skillsStoragePath", join(paths.dataDir, "new-skills")),
    ).rejects.toThrow("copy failed");

    expect(
      await readFile(join(paths.skillsDir, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
    expect((await config.list()).skillsStoragePath).toBeNull();
  });

  test("verification failure preserves the original storage and config", async () => {
    const paths = await fixture();
    await addSkill(paths.skillsDir);
    await symlink("SKILL.md", join(paths.skillsDir, "sk_example", "linked.md"));
    const config = new ConfigStore(paths);

    await expect(
      config.set("skillsStoragePath", join(paths.dataDir, "new-skills")),
    ).rejects.toThrow();

    expect(
      await readFile(join(paths.skillsDir, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
    expect((await config.list()).skillsStoragePath).toBeNull();
  });

  test("target update failure restores the original storage and config", async () => {
    const paths = await fixture();
    await addSkill(paths.skillsDir);
    const config = new ConfigStore(
      paths,
      new SkillsStorageMigrator({
        async migrate() {
          throw new Error("target update failed");
        },
      }),
    );

    await expect(
      config.set("skillsStoragePath", join(paths.dataDir, "new-skills")),
    ).rejects.toThrow("target update failed");

    expect(
      await readFile(join(paths.skillsDir, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
    expect((await config.list()).skillsStoragePath).toBeNull();
  });

  test("a config persistence failure restores target references and canonical storage", async () => {
    const paths = await fixture();
    await addSkill(paths.skillsDir);
    let rolledBack = false;
    const migrator = new SkillsStorageMigrator({
      async migrate() {
        return async () => {
          rolledBack = true;
        };
      },
    });

    await expect(
      migrator.migrate({
        from: paths.skillsDir,
        to: join(paths.dataDir, "new-skills"),
        persist: async () => {
          throw new Error("config write failed");
        },
      }),
    ).rejects.toThrow("config write failed");

    expect(rolledBack).toBeTrue();
    expect(
      await readFile(join(paths.skillsDir, "sk_example", "SKILL.md"), "utf8"),
    ).toBe("# Skill\n");
  });
});
