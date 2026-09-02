import { describe, expect, test } from "bun:test";

import { GitSourceError } from "../../../packages/skills-adapter/src/git-source";
import {
  classifyGitInitError,
  InitError,
  INIT_PROVIDER_PROMPT,
  resolveInitProvider,
} from "./init-errors";

describe("init provider selection", () => {
  test("non-interactive missing provider is a typed actionable error", async () => {
    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: true,
        ask: async () => {
          throw new Error("prompted");
        },
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_REQUIRED",
      outcome: "INVALID_CONFIG",
      message: expect.stringContaining("init repository"),
    });
  });

  test("interactive TTY asks Git Sync vs Corotum Cloud and does not require an agent", async () => {
    const questions: string[] = [];
    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: false,
        ask: async (question) => {
          questions.push(question);
          if (question === INIT_PROVIDER_PROMPT) return "1";
          return "git@example.test:state.git";
        },
      }),
    ).resolves.toEqual({ kind: "git", repository: "git@example.test:state.git" });
    expect(questions[0]).toContain("How do you want to sync?");
    expect(questions[0]).toContain("Git Sync");
    expect(questions[0]).toContain("Corotum Cloud");

    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: false,
        ask: async (question) => {
          if (question === INIT_PROVIDER_PROMPT) return "cloud";
          throw new Error("prompted for git url");
        },
      }),
    ).resolves.toEqual({ kind: "cloud" });
  });

  test("explicit repository and cloud forms remain valid", async () => {
    await expect(
      resolveInitProvider({
        provider: "repository",
        repository: "/tmp/state.git",
        nonInteractive: true,
        ask: async () => {
          throw new Error("prompted");
        },
      }),
    ).resolves.toEqual({ kind: "git", repository: "/tmp/state.git" });
    await expect(
      resolveInitProvider({
        provider: "cloud",
        repository: undefined,
        nonInteractive: true,
        ask: async () => {
          throw new Error("prompted");
        },
      }),
    ).resolves.toEqual({ kind: "cloud" });
    await expect(
      resolveInitProvider({
        provider: "/tmp/legacy.git",
        repository: undefined,
        nonInteractive: true,
        ask: async () => {
          throw new Error("prompted");
        },
      }),
    ).resolves.toEqual({ kind: "git", repository: "/tmp/legacy.git" });
  });

  test("non-interactive repository without a Git URL never prompts", async () => {
    await expect(
      resolveInitProvider({
        provider: "repository",
        repository: undefined,
        nonInteractive: true,
        ask: async () => {
          throw new Error("prompted");
        },
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_REQUIRED", outcome: "INVALID_CONFIG" });
  });
});

describe("git init error classification", () => {
  test("maps missing Git, invalid repo, unavailable remote, and auth failures", () => {
    expect(classifyGitInitError(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }))).toMatchObject({
      code: "GIT_MISSING",
    });
    expect(classifyGitInitError(new Error("fatal: not a git repository"))).toMatchObject({
      code: "INVALID_GIT_REPOSITORY",
    });
    expect(classifyGitInitError(new Error("fatal: unable to access 'https://127.0.0.1:1/repo.git': Failed to connect"))).toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      outcome: "NETWORK_ERROR",
    });
    expect(classifyGitInitError(new GitSourceError("AUTH_REQUIRED", "private"))).toMatchObject({
      code: "AUTH_REQUIRED",
      outcome: "AUTH_REQUIRED",
    });
    expect(classifyGitInitError(new InitError("already", "ALREADY_INITIALIZED"))).toMatchObject({
      code: "ALREADY_INITIALIZED",
    });
  });
});
