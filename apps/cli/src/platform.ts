import { join } from "node:path";

export type Platform = "darwin" | "linux" | "win32";

export type PlatformEnvironment = Readonly<{
  homeDir: string;
  platform: Platform;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type CorotumPaths = Readonly<{
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

/** Resolves all local Corotum paths in one platform-aware place. */
export function resolvePlatformPaths(
  env: PlatformEnvironment,
): CorotumPaths {
  const { homeDir, platform } = env;

  if (!homeDir) {
    throw new Error(
      "A home directory is required to resolve Corotum paths.",
    );
  }

  if (platform === "darwin") {
    const configDir = join(
      homeDir,
      "Library",
      "Application Support",
      "Corotum",
    );
    const dataDir = join(
      homeDir,
      "Library",
      "Application Support",
      "Corotum",
    );
    const stateDir = join(
      homeDir,
      "Library",
      "Application Support",
      "Corotum",
      "state",
    );
    return paths(configDir, dataDir, stateDir, join(stateDir, "runtime"), homeDir);
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
      join(appData, "Corotum"),
      join(localAppData, "Corotum"),
      join(localAppData, "Corotum", "state"),
      join(localAppData, "Corotum", "runtime"),
      homeDir,
    );
  }

  const configDir = join(
    valueOr(env, "XDG_CONFIG_HOME", join(homeDir, ".config")),
    "corotum",
  );
  const dataDir = join(
    valueOr(env, "XDG_DATA_HOME", join(homeDir, ".local", "share")),
    "corotum",
  );
  const stateDir = join(
    valueOr(env, "XDG_STATE_HOME", join(homeDir, ".local", "state")),
    "corotum",
  );
  return paths(
    configDir,
    dataDir,
    stateDir,
    join(valueOr(env, "XDG_RUNTIME_DIR", stateDir), "corotum"),
    homeDir,
  );
}

/** Previous ToolMirror roots kept as a recoverable migration source. */
export function resolveLegacyPlatformPaths(
  env: PlatformEnvironment,
): CorotumPaths {
  const { homeDir, platform } = env;
  if (!homeDir) {
    throw new Error(
      "A home directory is required to resolve Corotum paths.",
    );
  }
  if (platform === "darwin") {
    const root = join(homeDir, "Library", "Application Support", "ToolMirror");
    return paths(root, root, join(root, "state"), join(root, "state", "runtime"), homeDir, join(root, "skills"));
  }
  if (platform === "win32") {
    const appData = valueOr(env, "APPDATA", join(homeDir, "AppData", "Roaming"));
    const localAppData = valueOr(env, "LOCALAPPDATA", join(homeDir, "AppData", "Local"));
    return paths(
      join(appData, "ToolMirror"),
      join(localAppData, "ToolMirror"),
      join(localAppData, "ToolMirror", "state"),
      join(localAppData, "ToolMirror", "runtime"),
      homeDir,
      join(localAppData, "ToolMirror", "skills"),
    );
  }
  const configDir = join(valueOr(env, "XDG_CONFIG_HOME", join(homeDir, ".config")), "toolmirror");
  const dataDir = join(valueOr(env, "XDG_DATA_HOME", join(homeDir, ".local", "share")), "toolmirror");
  const stateDir = join(valueOr(env, "XDG_STATE_HOME", join(homeDir, ".local", "state")), "toolmirror");
  return paths(
    configDir,
    dataDir,
    stateDir,
    join(valueOr(env, "XDG_RUNTIME_DIR", stateDir), "toolmirror"),
    homeDir,
    join(dataDir, "skills"),
  );
}

function paths(
  configDir: string,
  dataDir: string,
  stateDir: string,
  runtimeDir: string,
  homeDir: string,
  skillsDir = join(homeDir, ".agents", "skills"),
): CorotumPaths {
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    credentialsFile: join(configDir, "credentials.json"),
    dataDir,
    gitDir: join(dataDir, "git"),
    runtimeDir,
    skillsDir,
    stateDir,
  };
}
