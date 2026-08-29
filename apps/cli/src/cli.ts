import { Command, CommanderError } from "commander";
import { registerAddCommand } from "./add-command";
import { registerAdoptCommand } from "./adopt-command";
import {
  type CliOutcome,
  ExitCode,
  exitCodeFor,
  jsonEnvelope,
} from "./cli-contracts";
import { registerInitCommand } from "./init-command";
import { registerRemoveCommands } from "./remove-command";

export const CLI_VERSION = "0.1.0";

export type CliOptions = Readonly<{
  json: boolean;
  nonInteractive: boolean;
}>;

export type CliIo = Readonly<{
  stdinIsTTY: boolean | undefined;
  writeError: (message: string) => void;
  writeOutput: (message: string) => void;
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
): Command {
  const program = new Command();
  program
    .name("toolmirror")
    .description("Keep your agent skills in sync.")
    .version(`toolmirror ${CLI_VERSION}`)
    .option("--json", "emit machine-readable JSON", false)
    .option("--non-interactive", "never prompt for input", false)
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

  program.action(() => {
    const options = program.opts<CliOptions>();
    if (options.json) {
      io.writeOutput(
        `${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS" }))}\n`,
      );
      return;
    }
    io.writeOutput("Run toolmirror --help to see available commands.\n");
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
): Promise<ExitCode> {
  const json = argv.includes("--json");
  if (json && isCommanderDisplayRequest(argv)) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS" }))}\n`);
    return ExitCode.SUCCESS;
  }

  const program = createCli(io, json);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return ExitCode.SUCCESS;
  } catch (error) {
    const outcome = outcomeFor(error);
    if (json) {
      io.writeOutput(
        `${JSON.stringify(
          jsonEnvelope({ outcome, error: errorMessage(error) }),
        )}\n`,
      );
    } else if (!(error instanceof CommanderError)) {
      io.writeError(`${errorMessage(error)}\n`);
    }
    return exitCodeFor(outcome);
  }
}

function outcomeFor(error: unknown): CliOutcome {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  ) {
    return "SUCCESS";
  }
  return "GENERAL_ERROR";
}

function isCommanderDisplayRequest(argv: readonly string[]): boolean {
  return argv.some((argument) =>
    ["--help", "-h", "--version", "-V"].includes(argument),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "ToolMirror command failed.";
}
