import { describe, expect, test } from "bun:test";

import { GitSourceError } from "../../../packages/skills-adapter/src/git-source";
import {
  classifyGitInitError,
  GitCliError,
  InitError,
  resolveInitProvider,
} from "./init-errors";

const noPrompt = {
  chooseProvider: async () => {
    throw new Error("prompted");
  },
  askRepository: async () => {
    throw new Error("prompted");
  },
};

describe("init provider selection", () => {
  test("non-interactive missing provider is a typed actionable error", async () => {
    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: true,
        ...noPrompt,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_REQUIRED",
      outcome: "INVALID_CONFIG",
      message: expect.stringContaining("init repository"),
    });
  });

  test("interactive TTY asks Git Sync vs Corotum Cloud and does not require an agent", async () => {
    const choices: string[] = [];
    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: false,
        chooseProvider: async () => {
          choices.push("provider");
          return "git";
        },
        askRepository: async () => "git@example.test:state.git",
      }),
    ).resolves.toEqual({
      kind: "git",
      repository: "git@example.test:state.git",
    });
    expect(choices).toEqual(["provider"]);

    await expect(
      resolveInitProvider({
        provider: undefined,
        repository: undefined,
        nonInteractive: false,
        chooseProvider: async () => "cloud",
        askRepository: async () => {
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
        ...noPrompt,
      }),
    ).resolves.toEqual({ kind: "git", repository: "/tmp/state.git" });
    await expect(
      resolveInitProvider({
        provider: "cloud",
        repository: undefined,
        nonInteractive: true,
        ...noPrompt,
      }),
    ).resolves.toEqual({ kind: "cloud" });
    await expect(
      resolveInitProvider({
        provider: "/tmp/legacy.git",
        repository: undefined,
        nonInteractive: true,
        ...noPrompt,
      }),
    ).resolves.toEqual({ kind: "git", repository: "/tmp/legacy.git" });
  });

  test("non-interactive repository without a Git URL never prompts", async () => {
    await expect(
      resolveInitProvider({
        provider: "repository",
        repository: undefined,
        nonInteractive: true,
        ...noPrompt,
      }),
    ).rejects.toMatchObject({
      code: "REPOSITORY_REQUIRED",
      outcome: "INVALID_CONFIG",
    });
  });
});

describe("git init error classification", () => {
  test("maps missing Git, invalid repo, unavailable remote, and auth failures", () => {
    expect(
      classifyGitInitError(
        Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      ),
    ).toMatchObject({
      code: "GIT_MISSING",
    });
    expect(
      classifyGitInitError(new Error("fatal: not a git repository")),
    ).toMatchObject({
      code: "INVALID_GIT_REPOSITORY",
    });
    expect(
      classifyGitInitError(
        new Error(
          "fatal: unable to access 'https://127.0.0.1:1/repo.git': Failed to connect",
        ),
      ),
    ).toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      outcome: "NETWORK_ERROR",
    });
    expect(
      classifyGitInitError(new GitSourceError("AUTH_REQUIRED", "private")),
    ).toMatchObject({
      code: "AUTH_REQUIRED",
      outcome: "AUTH_REQUIRED",
    });
    expect(
      classifyGitInitError(new InitError("already", "ALREADY_INITIALIZED")),
    ).toMatchObject({
      code: "ALREADY_INITIALIZED",
    });
    expect(
      classifyGitInitError(new Error("Git authentication is required.")),
    ).toBeInstanceOf(GitCliError);
    expect(
      classifyGitInitError(new Error("Git state operation failed.")),
    ).toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      outcome: "NETWORK_ERROR",
    });
    expect(
      classifyGitInitError(
        new GitSourceError(
          "SOURCE_UNAVAILABLE",
          "fatal: does not appear to be a git repository",
        ),
      ),
    ).toMatchObject({
      code: "INVALID_GIT_REPOSITORY",
      outcome: "INVALID_CONFIG",
    });
    expect(
      classifyGitInitError(
        new GitSourceError(
          "SOURCE_UNAVAILABLE",
          "Git could not access the requested source.",
        ),
      ),
    ).toMatchObject({ code: "INVALID_GIT_REPOSITORY" });
    const unknownSkill = classifyGitInitError(
      new Error("Managed skill was not found or is ambiguous."),
    );
    expect(unknownSkill).toBeInstanceOf(Error);
    expect(unknownSkill).not.toMatchObject({ code: "GIT_MISSING" });
    expect(unknownSkill.message).toBe(
      "Managed skill was not found or is ambiguous.",
    );
  });
});
