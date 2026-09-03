import { access } from "node:fs/promises";
import { homedir } from "node:os";

import {
  type AgentId,
  builtInAgentAdapters,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import {
  type GitCommandRunner,
  runSystemGit,
} from "../../../packages/skills-adapter/src/git-source";
import { formatCorotumBanner } from "./banner";
import { type Platform, resolvePlatformPaths } from "./platform";

export type WelcomeAgent = Readonly<{
  id: AgentId;
  name: string;
  detected: boolean;
}>;

export type WelcomeSnapshot = Readonly<{
  version: string;
  gitAvailable: boolean;
  osLabel: string;
  homeConfigured: boolean;
  agents: readonly WelcomeAgent[];
}>;

export type WelcomeDeps = Readonly<{
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  homeDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  gitAvailable: () => Promise<boolean>;
  detectAgentIds: (homeDir: string) => Promise<readonly AgentId[]>;
  configExists: (configFile: string) => Promise<boolean>;
}>;

export async function gitAvailable(
  runGit: GitCommandRunner = runSystemGit,
): Promise<boolean> {
  try {
    const result = await runGit({ args: ["--version"] });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function configFileExists(configFile: string): Promise<boolean> {
  try {
    await access(configFile);
    return true;
  } catch {
    return false;
  }
}

export function defaultWelcomeDeps(version: string): WelcomeDeps {
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    env: process.env,
    gitAvailable,
    detectAgentIds: async (homeDir) => {
      const detected = await detectAgents(homeDir, localAgentFileSystem);
      return detected.map((agent) => agent.id);
    },
    configExists: configFileExists,
  };
}

export async function collectWelcomeSnapshot(
  deps: WelcomeDeps,
): Promise<WelcomeSnapshot> {
  const paths = resolvePlatformPaths({
    homeDir: deps.homeDir,
    platform: platformOf(deps.platform),
    env: deps.env,
  });
  const [git, detectedIds, homeConfigured] = await Promise.all([
    deps.gitAvailable(),
    deps.detectAgentIds(deps.homeDir),
    deps.configExists(paths.configFile),
  ]);
  const detected = new Set(detectedIds);
  return {
    version: deps.version,
    gitAvailable: git,
    osLabel: `${osName(deps.platform)} ${deps.arch}`,
    homeConfigured,
    agents: builtInAgentAdapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      detected: detected.has(adapter.id),
    })),
  };
}

export function formatWelcomeScreen(snapshot: WelcomeSnapshot): string {
  const gitLine = snapshot.gitAvailable
    ? "  ✓ Git available"
    : "  ✗ Git unavailable";
  const homeLine = snapshot.homeConfigured
    ? "  ✓ Corotum home ready"
    : "  ○ Corotum home not configured";
  const agents = snapshot.agents
    .map((agent) => `  ${agent.detected ? "●" : "○"} ${agent.name}`)
    .join("\n");
  return [
    formatCorotumBanner(snapshot.version).trimEnd(),
    "",
    "Keep your agent skills in sync.",
    "One desired state across every machine and AI agent.",
    "",
    "Environment",
    gitLine,
    `  ✓ ${snapshot.osLabel}`,
    homeLine,
    "",
    "Detected agents",
    agents,
    "",
    "Sync modes",
    "  Git Sync       Free, backed by your Git repository",
    "  Corotum Cloud  Hosted sync across all your devices",
    "",
    "Get started",
    "  › corotum init        Configure this device",
    "  › corotum status      Show local sync state",
    "  › corotum --help      View all commands",
    "",
    "https://corotum.com",
    "",
  ].join("\n");
}

function platformOf(platform: NodeJS.Platform): Platform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  return "linux";
}

function osName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}
