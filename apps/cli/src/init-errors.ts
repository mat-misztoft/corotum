import {
  type GitCommandRunner,
  GitSourceError,
  runSystemGit,
} from "../../../packages/skills-adapter/src/git-source";
import type { CliOutcome } from "./cli-contracts";

export type InitErrorCode =
  | "PROVIDER_REQUIRED"
  | "REPOSITORY_REQUIRED"
  | "ALREADY_INITIALIZED"
  | "GIT_MISSING"
  | "INVALID_GIT_REPOSITORY"
  | "REMOTE_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "INVALID_ARGUMENT";

export class InitError extends Error {
  readonly name = "InitError";

  constructor(
    message: string,
    readonly code: InitErrorCode,
    readonly outcome: CliOutcome = outcomeForInitCode(code),
  ) {
    super(message);
  }
}

export type InitProviderSelection =
  | Readonly<{ kind: "cloud" }>
  | Readonly<{ kind: "git"; repository: string }>;

export const INIT_PROVIDER_PROMPT =
  "How do you want to sync?\n\n1) Git Sync\n2) Corotum Cloud\n\nChoice [1/2]: ";

export const INIT_REPOSITORY_PROMPT = "Git repository URL: ";

const PROVIDER_REQUIRED_MESSAGE =
  "A sync provider is required. Run `corotum init repository <git-url>` or `corotum init cloud`.";

const REPOSITORY_REQUIRED_MESSAGE =
  "A Git repository URL is required. Run `corotum init repository <git-url>`.";

export async function resolveInitProvider(input: {
  provider: string | undefined;
  repository: string | undefined;
  nonInteractive: boolean;
  ask: (question: string) => Promise<string>;
}): Promise<InitProviderSelection> {
  const token = input.provider?.trim();
  if (!token) {
    if (input.nonInteractive) {
      throw new InitError(PROVIDER_REQUIRED_MESSAGE, "PROVIDER_REQUIRED");
    }
    const selected = parseProviderChoice(await input.ask(INIT_PROVIDER_PROMPT));
    if (selected === "cloud") {
      rejectCloudRepository(input.repository);
      return { kind: "cloud" };
    }
    return { kind: "git", repository: await requireGitRepository(input) };
  }

  if (token === "cloud") {
    rejectCloudRepository(input.repository);
    return { kind: "cloud" };
  }

  if (token === "repository") {
    return { kind: "git", repository: await requireGitRepository(input) };
  }

  if (input.repository?.trim()) {
    throw new InitError(
      "Unexpected extra argument. Use `corotum init repository <git-url>` or `corotum init cloud`.",
      "INVALID_ARGUMENT",
    );
  }
  return { kind: "git", repository: token };
}

export async function assertGitAvailable(
  runGit: GitCommandRunner = runSystemGit,
): Promise<void> {
  try {
    const result = await runGit({ args: ["--version"] });
    if (result.exitCode === 0) return;
  } catch (error) {
    if (error instanceof InitError) throw error;
    throw missingGitError(error);
  }
  throw missingGitError();
}

export function throwGitInitError(error: unknown): never {
  throw classifyGitInitError(error);
}

export function classifyGitInitError(error: unknown): Error {
  if (error instanceof InitError) return error;
  if (error instanceof GitSourceError) {
    if (error.code === "AUTH_REQUIRED") return authGitError();
    if (error.code === "INVALID_SOURCE" || error.code === "CREDENTIALS_IN_URL") {
      return invalidGitRepositoryError();
    }
    if (error.code === "SOURCE_UNAVAILABLE") return unavailableRemoteError();
  }
  if (isMissingGit(error)) return missingGitError(error);
  const message = errorMessage(error);
  if (
    /authentication|authorization|permission denied|could not read username|terminal prompts disabled|publickey/i.test(
      message,
    )
  ) {
    return authGitError();
  }
  if (
    /not a git repository|does not appear to be a git repository|repository .* does not exist|failed to stat|is this a git repository/i.test(
      message,
    )
  ) {
    return invalidGitRepositoryError();
  }
  if (
    /could not resolve host|unable to access|connection refused|network is unreachable|timed out|temporarily unavailable|failed to connect|could not read from remote/i.test(
      message,
    )
  ) {
    return unavailableRemoteError();
  }
  return error instanceof Error ? error : new Error(message);
}

function parseProviderChoice(answer: string): "git" | "cloud" {
  const normalized = answer.trim().toLowerCase();
  if (["1", "git", "g", "repository", "git sync"].includes(normalized)) {
    return "git";
  }
  if (["2", "cloud", "c", "corotum cloud"].includes(normalized)) {
    return "cloud";
  }
  throw new InitError(
    "Choose Git Sync or Corotum Cloud. Run `corotum init repository <git-url>` or `corotum init cloud`.",
    "PROVIDER_REQUIRED",
  );
}

async function requireGitRepository(input: {
  repository: string | undefined;
  nonInteractive: boolean;
  ask: (question: string) => Promise<string>;
}): Promise<string> {
  const provided = input.repository?.trim();
  if (provided) return provided;
  if (input.nonInteractive) {
    throw new InitError(REPOSITORY_REQUIRED_MESSAGE, "REPOSITORY_REQUIRED");
  }
  const value = (await input.ask(INIT_REPOSITORY_PROMPT)).trim();
  if (!value) {
    throw new InitError(REPOSITORY_REQUIRED_MESSAGE, "REPOSITORY_REQUIRED");
  }
  return value;
}

function rejectCloudRepository(repository: string | undefined): void {
  if (repository?.trim()) {
    throw new InitError(
      "Corotum Cloud init does not take a Git repository argument. Run `corotum init cloud`.",
      "INVALID_ARGUMENT",
    );
  }
}

function outcomeForInitCode(code: InitErrorCode): CliOutcome {
  switch (code) {
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "REMOTE_UNAVAILABLE":
      return "NETWORK_ERROR";
    case "ALREADY_INITIALIZED":
      return "CONFLICT";
    case "GIT_MISSING":
      return "GENERAL_ERROR";
    default:
      return "INVALID_CONFIG";
  }
}

function missingGitError(_error?: unknown): InitError {
  return new InitError(
    "Git is not installed or not available on PATH. Install Git and retry `corotum init repository`.",
    "GIT_MISSING",
  );
}

function authGitError(): InitError {
  return new InitError(
    "Git authentication failed. Configure Git credentials for this repository and retry.",
    "AUTH_REQUIRED",
  );
}

function invalidGitRepositoryError(): InitError {
  return new InitError(
    "The Git repository is invalid or is not a Git repository. Provide a valid Git remote or path.",
    "INVALID_GIT_REPOSITORY",
  );
}

function unavailableRemoteError(): InitError {
  return new InitError(
    "The Git remote is unavailable. Check the URL and network, then retry.",
    "REMOTE_UNAVAILABLE",
  );
}

function isMissingGit(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTFOUND") return true;
  }
  return /not found|enoent|git: command not found|spawn git/i.test(
    errorMessage(error),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
