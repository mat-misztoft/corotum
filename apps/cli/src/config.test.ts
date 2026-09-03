import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigStore,
  CredentialsStore,
  defaultConfig,
  effectiveStoragePaths,
} from "./config";
import { type CorotumPaths, resolvePlatformPaths } from "./platform";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryPaths(): Promise<CorotumPaths> {
  const root = await mkdtemp(join(tmpdir(), "corotum-config-"));
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

describe("platform paths", () => {
  test("resolves platform conventions and XDG overrides from fixtures", () => {
    expect(
      resolvePlatformPaths({ homeDir: "/home/alex", platform: "linux" }),
    ).toMatchObject({
      configFile: "/home/alex/.config/corotum/config.json",
      dataDir: "/home/alex/.local/share/corotum",
      stateDir: "/home/alex/.local/state/corotum",
      runtimeDir: "/home/alex/.local/state/corotum/corotum",
    });
    expect(
      resolvePlatformPaths({
        homeDir: "/home/alex",
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/config",
          XDG_DATA_HOME: "/data",
          XDG_STATE_HOME: "/state",
          XDG_RUNTIME_DIR: "/run/user/42",
        },
      }),
    ).toMatchObject({
      configDir: "/config/corotum",
      dataDir: "/data/corotum",
      stateDir: "/state/corotum",
      runtimeDir: "/run/user/42/corotum",
    });
    expect(
      resolvePlatformPaths({ homeDir: "/Users/alex", platform: "darwin" }),
    ).toMatchObject({
      configDir: "/Users/alex/Library/Application Support/Corotum",
      dataDir: "/Users/alex/Library/Application Support/Corotum",
      skillsDir: "/Users/alex/.agents/skills",
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
      runtimeDir: "C:\\Local/Corotum/runtime",
      skillsDir: "C:\\Users\\alex/.agents/skills",
    });
  });
});

describe("local configuration", () => {
  test("rejects invalid manual and programmatic configuration without replacing valid config", async () => {
    const paths = await temporaryPaths();
    const config = new ConfigStore(paths);
    const managedSkills = join(paths.dataDir, "managed-skills");
    const written = await config.set("skillsStoragePath", managedSkills);
    expect(written.skillsStoragePath).toBe(managedSkills);

    await writeFile(paths.configFile, '{"schemaVersion":2}\n');
    await expect(config.list()).rejects.toThrow();

    await writeFile(paths.configFile, JSON.stringify(written));
    await expect(config.set("telemetry", "yes")).rejects.toThrow();
    expect(await config.list()).toEqual(written);
  });

  test("uses platform defaults and creates an empty relocated storage before changing config", async () => {
    const paths = await temporaryPaths();
    const config = new ConfigStore(paths);
    const relocated = join(paths.dataDir, "another-store");
    expect(effectiveStoragePaths(await config.list(), paths)).toEqual({
      gitStoragePath: paths.gitDir,
      skillsStoragePath: paths.skillsDir,
    });

    await config.set("skillsStoragePath", relocated);
    expect(
      effectiveStoragePaths(await config.list(), paths).skillsStoragePath,
    ).toBe(relocated);
    await stat(relocated);
    await expect(stat(paths.skillsDir)).rejects.toThrow();
    expect(defaultConfig().gitStoragePath).toBeNull();
  });
});

describe("credentials", () => {
  test("stores credentials separately with restrictive permissions", async () => {
    const paths = await temporaryPaths();
    const config = new ConfigStore(paths);
    const credentials = new CredentialsStore(paths);

    await config.set("mode", "cloud");
    await credentials.save({
      schemaVersion: 1,
      cloudDeviceToken: "secret-token",
    });

    expect(await readFile(paths.configFile, "utf8")).not.toContain(
      "secret-token",
    );
    expect(await credentials.load()).toEqual({
      schemaVersion: 1,
      cloudDeviceToken: "secret-token",
    });
    if (process.platform !== "win32") {
      expect((await stat(paths.configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.credentialsFile)).mode & 0o777).toBe(0o600);
    }
  });
});
