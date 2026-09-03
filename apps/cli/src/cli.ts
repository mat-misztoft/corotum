import { Command, CommanderError } from "commander";
import { V2ArtifactConsentRequiredError } from "../../../packages/git-provider/src/index";
import { registerAddCommand } from "./add-command";
import { registerAgentsCommand } from "./agents-command";
import { registerAdoptCommand } from "./adopt-command";
import {
  type CliOutcome,
  ExitCode,
  exitCodeFor,
  jsonEnvelope,
} from "./cli-contracts";
import { registerCliUpdateCommand } from "./cli-update-command";
import { CloudAuthError } from "./cloud-auth";
import { CloudInitError } from "./init-cloud";
import { registerCloudAuthCommands } from "./cloud-auth-command";
import { ConfigError, registerConfigCommand } from "./config-command";
import { classifyGitInitError, GitCliError, InitError } from "./init-errors";
import { registerInitCommand } from "./init-command";
import { registerMigrateCommand } from "./migrate-command";
import { registerRemoveCommands } from "./remove-command";
import { registerResetCommand } from "./reset-command";
import { registerRestoreCommand } from "./restore-command";
import { registerSetRefCommand } from "./set-ref-command";
import { registerSyncCommands } from "./sync-command";
import { isHelpOrVersionArgv, type CliTelemetry } from "./telemetry";
import { registerUpdateCommand } from "./update-command";
import {
  collectWelcomeSnapshot,
  defaultWelcomeDeps,
  formatWelcomeScreen,
  type WelcomeDeps,
} from "./welcome";

export const CLI_VERSION = "0.6.0";

export type CliOptions = Readonly<{
  json: boolean;
  nonInteractive: boolean;
  allowArtifacts: boolean;
}>;

export type CliIo = Readonly<{
  stdinIsTTY: boolean | undefined;
  writeError: (message: string) => void;
  writeOutput: (message: string) => void;
  readQuestion?: (question: string) => Promise<string>;
}>;

const processIo = (): CliIo => ({
  stdinIsTTY: process.stdin.isTTY,
  writeError: (message) => process.stderr.write(message),
  writeOutput: (message) => process.stdout.write(message),
});

/** No TTY and --non-interactive both prohibit a prompt-capable command. */
export function isNonInteractive(
  options: Pick<CliOptions, "nonInteractive">,
  stdinIsTTY: boolean | undefined,
): boolean {
  return options.nonInteractive || stdinIsTTY !== true;
}

export function createCli(
  io: CliIo = processIo(),
  suppressErrorOutput = false,
  welcome: WelcomeDeps = defaultWelcomeDeps(CLI_VERSION),
): Command {
  const program = new Command();
  program
    .name("corotum")
    .description("Keep your agent skills in sync.")
    .version(`corotum ${CLI_VERSION}`)
    .option("--json", "emit machine-readable JSON", false)
    .option("--non-interactive", "never prompt for input", false)
    .option(
      "--allow-artifacts",
      "allow committing exact local artifact content to Git",
      false,
    )
    .allowUnknownOption(false)
    .configureOutput({
      writeErr: suppressErrorOutput ? () => undefined : io.writeError,
      writeOut: io.writeOutput,
    })
    .exitOverride();

  registerInitCommand(program, io);
  registerAddCommand(program, io);
  registerAdoptCommand(program, io);
  registerRemoveCommands(program, io);
  registerRestoreCommand(program, io);
  registerUpdateCommand(program, io);
  registerCliUpdateCommand(program, io, CLI_VERSION);
  registerSetRefCommand(program, io);
  registerSyncCommands(program, io);
  registerAgentsCommand(program, io);
  registerConfigCommand(program, io);
  registerCloudAuthCommands(program, io);
  registerResetCommand(program, io);
  registerMigrateCommand(program, io);

  program.action(async () => {
    const options = program.opts<CliOptions>();
    if (options.json) {
      io.writeOutput(
        `${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS" }))}\n`,
      );
      return;
    }
    io.writeOutput(
      formatWelcomeScreen(await collectWelcomeSnapshot(welcome)),
    );
  });

  return program;
}

/**
 * Parses CLI arguments without terminating the host process, making the same
 * exit-code and JSON contracts available to tests and compiled execution.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo(),
  telemetry?: CliTelemetry,
  welcome?: WelcomeDeps,
): Promise<ExitCode> {
  const json = argv.includes("--json");
  const displayOnly = isHelpOrVersionArgv(argv);
  if (json && displayOnly) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS" }))}\n`);
    return ExitCode.SUCCESS;
  }

  const pending = displayOnly
    ? null
    : await telemetry?.begin(
        argv,
        !json &&
          !isNonInteractive(
            { nonInteractive: argv.includes("--non-interactive") },
            io.stdinIsTTY,
          ),
      );
  const program = createCli(
    io,
    json,
    welcome ?? defaultWelcomeDeps(CLI_VERSION),
  );
  let outcome: CliOutcome = "SUCCESS";
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    const classified = classifyGitInitError(error);
    outcome = outcomeFor(classified);
    if (json) {
      io.writeOutput(
        `${JSON.stringify(
          jsonEnvelope({
            outcome:
              classified instanceof V2ArtifactConsentRequiredError
                ? "CONFIRMATION_REQUIRED"
                : outcome,
            error: errorMessage(classified),
          }),
        )}\n`,
      );
    } else if (!(classified instanceof CommanderError)) {
      io.writeError(`${errorMessage(classified)}\n`);
    }
  }
  await telemetry?.finish(pending ?? null, outcome);
  return exitCodeFor(outcome);
}

function outcomeFor(error: unknown): CliOutcome {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  ) {
    return "SUCCESS";
  }
  if (error instanceof CloudAuthError) return error.outcome;
  if (error instanceof CloudInitError) return "GENERAL_ERROR";
  if (error instanceof ConfigError) return error.outcome;
  if (error instanceof InitError) return error.outcome;
  if (error instanceof GitCliError) return error.outcome;
  if (error instanceof Error && error.name === "V2CloudProviderError") {
    const code = (error as { code?: string }).code;
    if (code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
    if (code === "NETWORK_ERROR") return "NETWORK_ERROR";
    if (code === "CONFLICT") return "CONFLICT";
  }
  return "GENERAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Corotum command failed.";
}
