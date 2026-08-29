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
    expect(help.output.join("")).toContain("Usage: toolmirror");

    const version = fixtureIo();
    expect(await runCli(["--version"], version.io)).toBe(ExitCode.SUCCESS);
    expect(version.output.join("")).toBe(`toolmirror ${CLI_VERSION}\n`);
  });
});
