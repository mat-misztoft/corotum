import { join } from "node:path";

export type Platform = "darwin" | "linux" | "win32";

export type PlatformEnvironment = Readonly<{
  homeDir: string;
  platform: Platform;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type ToolMirrorPaths = Readonly<{
  configDir: string;
  configFile: string;
  credentialsFile: string;
  dataDir: string;
  gitDir: string;
  runtimeDir: string;
  skillsDir: string;
  stateDir: string;
}>;

function valueOr(
  env: PlatformEnvironment,
  key: string,
  fallback: string,
): string {
  const value = env.env?.[key];
  return value && value.length > 0 ? value : fallback;
}

/** Resolves all local ToolMirror paths in one platform-aware place. */
export function resolvePlatformPaths(
  env: PlatformEnvironment,
): ToolMirrorPaths {
  const { homeDir, platform } = env;

  if (!homeDir) {
    throw new Error(
      "A home directory is required to resolve ToolMirror paths.",
    );
  }

  if (platform === "darwin") {
    const configDir = join(
      homeDir,
      "Library",
      "Application Support",
      "ToolMirror",
    );
    const dataDir = join(
      homeDir,
      "Library",
      "Application Support",
      "ToolMirror",
    );
    const stateDir = join(
      homeDir,
      "Library",
      "Application Support",
      "ToolMirror",
      "state",
    );
    return paths(configDir, dataDir, stateDir, join(stateDir, "runtime"));
  }

  if (platform === "win32") {
    const appData = valueOr(
      env,
      "APPDATA",
      join(homeDir, "AppData", "Roaming"),
    );
    const localAppData = valueOr(
      env,
      "LOCALAPPDATA",
      join(homeDir, "AppData", "Local"),
    );
    return paths(
      join(appData, "ToolMirror"),
      join(localAppData, "ToolMirror"),
      join(localAppData, "ToolMirror", "state"),
      join(localAppData, "ToolMirror", "runtime"),
    );
  }

  const configDir = join(
    valueOr(env, "XDG_CONFIG_HOME", join(homeDir, ".config")),
    "toolmirror",
  );
  const dataDir = join(
    valueOr(env, "XDG_DATA_HOME", join(homeDir, ".local", "share")),
    "toolmirror",
  );
  const stateDir = join(
    valueOr(env, "XDG_STATE_HOME", join(homeDir, ".local", "state")),
    "toolmirror",
  );
  return paths(
    configDir,
    dataDir,
    stateDir,
    join(valueOr(env, "XDG_RUNTIME_DIR", stateDir), "toolmirror"),
  );
}

function paths(
  configDir: string,
  dataDir: string,
  stateDir: string,
  runtimeDir: string,
): ToolMirrorPaths {
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    credentialsFile: join(configDir, "credentials.json"),
    dataDir,
    gitDir: join(dataDir, "git"),
    runtimeDir,
    skillsDir: join(dataDir, "skills"),
    stateDir,
  };
}
