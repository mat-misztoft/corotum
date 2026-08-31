export * from "./targets";

import { stat } from "node:fs/promises";
import { join } from "node:path";

export const builtInAgentIds = [
  "codex",
  "claude-code",
  "pi",
  "gemini-cli",
  "opencode",
  "cursor",
  "windsurf",
  "cline",
  "roo-code",
  "github-copilot",
  "kiro-cli",
] as const;

export type AgentId = (typeof builtInAgentIds)[number];

export type AgentAdapter = Readonly<{
  id: AgentId;
  name: string;
  detectionPaths: (homeDir: string) => readonly string[];
  globalSkillPaths: (homeDir: string) => readonly string[];
}>;

export type DetectedAgent = Readonly<{ id: AgentId }>;

export type AgentDetectionFileSystem = Readonly<{
  directoryExists: (path: string) => Promise<boolean>;
}>;

/** Filesystem adapter for detection on the current device. */
export const localAgentFileSystem: AgentDetectionFileSystem = {
  directoryExists: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

const homeDirectory = (directory: string) => (homeDir: string) => [
  join(homeDir, directory),
];

const agent = (
  id: AgentId,
  name: string,
  directory: string,
  skillsDirectory = directory,
): AgentAdapter => ({
  id,
  name,
  detectionPaths: homeDirectory(directory),
  globalSkillPaths: (homeDir) => [join(homeDir, skillsDirectory, "skills")],
});

/** Closed v0.1 registry. Adding an agent requires a Corotum release. */
export const builtInAgentAdapters: readonly AgentAdapter[] = [
  agent("codex", "Codex", ".codex"),
  agent("claude-code", "Claude Code", ".claude"),
  agent("pi", "Pi", ".pi", ".pi/agent"),
  agent("gemini-cli", "Gemini CLI", ".gemini"),
  agent("opencode", "OpenCode", ".config/opencode"),
  agent("cursor", "Cursor", ".cursor"),
  agent("windsurf", "Windsurf", ".codeium/windsurf"),
  agent("cline", "Cline", ".cline"),
  agent("roo-code", "Roo Code", ".roo"),
  agent("github-copilot", "GitHub Copilot", ".copilot"),
  agent("kiro-cli", "Kiro CLI", ".kiro"),
];

/**
 * Detects known local agent installations. The result intentionally contains
 * only public agent IDs: callers must keep filesystem paths local.
 */
export async function detectAgents(
  homeDir: string,
  fileSystem: AgentDetectionFileSystem,
  adapters: readonly AgentAdapter[] = builtInAgentAdapters,
): Promise<readonly DetectedAgent[]> {
  const detected = await Promise.all(
    adapters.map(async (adapter) => {
      const paths = adapter.detectionPaths(homeDir);
      return (await Promise.all(paths.map(fileSystem.directoryExists))).some(
        Boolean,
      )
        ? { id: adapter.id }
        : null;
    }),
  );

  return detected.filter((agent): agent is DetectedAgent => agent !== null);
}
