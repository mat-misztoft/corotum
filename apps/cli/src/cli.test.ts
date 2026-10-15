import { describe, expect, test } from "bun:test";
import { CLI_VERSION, type CliIo, isNonInteractive, runCli } from "./cli";
import {
  CLI_SCHEMA_VERSION,
  ExitCode,
  exitCodeFor,
  jsonEnvelope,
} from "./cli-contracts";

function fixtureIo(stdinIsTTY: boolean | undefined = true): {
  io: CliIo;
  output: string[];
  errors: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdinIsTTY,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    },
    output,
    errors,
  };
}

describe("CLI automation contracts", () => {
  test("defines each documented outcome as a deterministic exit code", () => {
    expect(ExitCode).toEqual({
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      PARTIAL_SUCCESS: 2,
      CONFLICT: 3,
      AUTH_REQUIRED: 4,
      INVALID_CONFIG: 5,
      NETWORK_ERROR: 6,
    });
    for (const [outcome, code] of Object.entries(ExitCode)) {
      expect(exitCodeFor(outcome as keyof typeof ExitCode)).toBe(code);
    }
  });

  test("wraps JSON responses in schema version 1", async () => {
    const { io, output, errors } = fixtureIo();
    expect(await runCli(["--json"], io)).toBe(ExitCode.SUCCESS);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toEqual(
      jsonEnvelope({ outcome: "SUCCESS" }),
    );
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: CLI_SCHEMA_VERSION,
    });
  });

  test("keeps parse failures machine-readable in JSON mode", async () => {
    const { io, output, errors } = fixtureIo();
    expect(await runCli(["--json", "--unknown"], io)).toBe(
      ExitCode.GENERAL_ERROR,
    );
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: 1,
      outcome: "GENERAL_ERROR",
    });
  });

  test("keeps Commander display requests machine-readable in JSON mode", async () => {
    const { io, output, errors } = fixtureIo();
    expect(await runCli(["--json", "--help"], io)).toBe(ExitCode.SUCCESS);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toEqual(
      jsonEnvelope({ outcome: "SUCCESS" }),
    );
  });

  test("treats absent TTY and explicit non-interactive mode as prompt-free", () => {
    expect(isNonInteractive({ nonInteractive: false }, undefined)).toBe(true);
    expect(isNonInteractive({ nonInteractive: false }, false)).toBe(true);
    expect(isNonInteractive({ nonInteractive: true }, true)).toBe(true);
    expect(isNonInteractive({ nonInteractive: false }, true)).toBe(false);
  });

  test("exposes help and the compiled CLI version contract", async () => {
    const help = fixtureIo();
    expect(await runCli(["--help"], help.io)).toBe(ExitCode.SUCCESS);
    expect(help.output.join("")).toContain("Usage: corotum");

    const version = fixtureIo();
    expect(await runCli(["--version"], version.io)).toBe(ExitCode.SUCCESS);
    expect(version.output.join("")).toBe(`corotum ${CLI_VERSION}\n`);
  });

  test("help snapshots match implemented flags and commands", async () => {
    const root = fixtureIo();
    expect(await runCli(["--help"], root.io)).toBe(ExitCode.SUCCESS);
    expect(root.output.join("").trimEnd()).toMatchInlineSnapshot(`
"Usage: corotum [options] [command]

Keep your agent skills in sync.

Options:
  -V, --version                                 output the version number
  --json                                        emit machine-readable JSON (default: false)
  --non-interactive                             never prompt for input (default: false)
  --allow-artifacts                             allow committing exact local artifact content to Git (default: false)
  -h, --help                                    display help for command

Commands:
  init [options] [provider] [repository]        initialize Git Sync or Corotum Cloud and safely adopt selected local skills
  add [options] <source>                        resolve and add one skill from a Git source
  adopt [options] <name>                        adopt one local skill from a matching Git source
  remove <skill>                                remove a managed skill from every reconciled device
  unmanage <skill>                              stop managing a skill while preserving local copies
  restore <skill>                               restore managed skill content from its exact locked revision
  update [options] [skill]                      check upstream skill revisions or update exact locks
  cli-update [options]                          update the Corotum CLI from official release metadata
  set-ref <skill> <ref>                         change a managed skill ref and lock its exact content
  status                                        show local skill reconciliation status
  diff                                          show the exact-lock reconciliation plan
  sync                                          reconcile local skills to the exact locked state
  agents                                        list, scan, enable, or disable optional local agents
  config                                        manage local configuration
  login [options]                               pair this device with Corotum Cloud in a browser
  logout [options]                              revoke this device token and remove local Cloud credentials
  auto                                          manage per-user automatic Cloud synchronization
  reset [options]                               delete Cloud desired-state skills and unlink this device
  migrate [options] <destination> [repository]  move desired state between Corotum Git Sync and Cloud, or migrate legacy ToolMirror state"
`);

    const init = fixtureIo();
    expect(await runCli(["init", "--help"], init.io)).toBe(ExitCode.SUCCESS);
    const initHelp = init.output.join("");
    expect(initHelp).toContain("--replace <name...>");
    expect(initHelp).toContain("--keep <name...>");
    expect(initHelp).toContain("--adopt-artifact <name...>");
    expect(initHelp).not.toContain("--source");

    const migrate = fixtureIo();
    expect(await runCli(["migrate", "--help"], migrate.io)).toBe(
      ExitCode.SUCCESS,
    );
    expect(migrate.output.join("")).toContain(
      "--strategy <replace|merge|cancel>",
    );
  });

  test("JSON snapshots keep schemaVersion 1 for success and parse errors", async () => {
    const ok = fixtureIo();
    expect(await runCli(["--json"], ok.io)).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(ok.output.join(""))).toMatchInlineSnapshot(`
{
  "outcome": "SUCCESS",
  "schemaVersion": 1,
}
`);

    const help = fixtureIo();
    expect(await runCli(["--json", "--help"], help.io)).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(help.output.join(""))).toEqual({
      schemaVersion: 1,
      outcome: "SUCCESS",
    });
  });
});
