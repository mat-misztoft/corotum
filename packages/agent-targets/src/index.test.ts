import { describe, expect, test } from "bun:test";
import {
  type AgentDetectionFileSystem,
  builtInAgentAdapters,
  builtInAgentIds,
  detectAgents,
} from "./index";

const home = "/home/tester";

function fixture(paths: readonly string[]): AgentDetectionFileSystem {
  const existing = new Set(paths);
  return { directoryExists: async (path) => existing.has(path) };
}

describe("built-in agent registry", () => {
  test("contains exactly the approved v0.1 global agents", () => {
    expect(builtInAgentIds).toEqual([
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
    ]);
    expect(builtInAgentAdapters.map((adapter) => adapter.id)).toEqual(
      builtInAgentIds,
    );
  });
});

describe("detectAgents", () => {
  test("reports only detected IDs and never local paths", async () => {
    const paths = [
      builtInAgentAdapters[0].detectionPaths(home)[0],
      builtInAgentAdapters[2].detectionPaths(home)[0],
      builtInAgentAdapters[10].detectionPaths(home)[0],
    ];

    await expect(detectAgents(home, fixture(paths))).resolves.toEqual([
      { id: "codex" },
      { id: "pi" },
      { id: "kiro-cli" },
    ]);
  });

  test("does not enable detected agents", async () => {
    const detected = await detectAgents(
      home,
      fixture([builtInAgentAdapters[0].detectionPaths(home)[0]]),
    );

    expect(detected).toEqual([{ id: "codex" }]);
    expect(detected[0]).not.toHaveProperty("enabled");
  });
});
