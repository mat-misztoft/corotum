import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  CloudAuthService,
  type CloudLoginResult,
  type CloudLogoutResult,
  cloudOriginFrom,
  DEFAULT_CLOUD_ORIGIN,
  defaultCloudDevice,
} from "./cloud-auth";
import { ConfigStore, CredentialsStore } from "./config";
import { SanitizedLogger } from "./logs";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";

export function registerCloudAuthCommands(program: Command, io: CliIo): void {
  program
    .command("login")
    .description("pair this device with ToolMirror Cloud in a browser")
    .option("--origin <url>", "Cloud origin", DEFAULT_CLOUD_ORIGIN)
    .action(async (options: { origin: string }) => {
      const { service, paths, origin } = context(program, io, options.origin);
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const result = await service.login();
        writeLogin(io, program, origin, result);
      } finally {
        await release();
      }
    });

  program
    .command("logout")
    .description("revoke this device token and remove local Cloud credentials")
    .option("--origin <url>", "Cloud origin", DEFAULT_CLOUD_ORIGIN)
    .action(async (options: { origin: string }) => {
      const { service, paths } = context(program, io, options.origin);
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        writeLogout(io, program, await service.logout());
      } finally {
        await release();
      }
    });
}

function context(
  program: Command,
  io: CliIo,
  originOption: string,
): {
  origin: string;
  paths: ReturnType<typeof resolvePlatformPaths>;
  service: CloudAuthService;
} {
  const origin = cloudOriginFrom(
    process.env.TOOLMIRROR_CLOUD_ORIGIN?.trim() || originOption,
  );
  const paths = resolvePlatformPaths({
    homeDir: homedir(),
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const json = program.opts<{ json?: boolean }>().json === true;
  const nonInteractive =
    program.opts<{ nonInteractive?: boolean }>().nonInteractive === true ||
    io.stdinIsTTY !== true;
  return {
    origin,
    paths,
    service: new CloudAuthService({
      origin,
      config: new ConfigStore(paths),
      credentials: new CredentialsStore(paths),
      logger: new SanitizedLogger(join(paths.stateDir, "logs")),
      device: defaultCloudDevice("0.1.0"),
      openBrowser: !nonInteractive,
      openUrl: json || nonInteractive ? undefined : openUrl,
      onPairing: ({ userCode, verificationUrl }) => {
        io.writeError(
          `Open ${verificationUrl} and approve this device.
Code: ${userCode}
`,
        );
      },
    }),
  };
}

function writeLogin(
  io: CliIo,
  program: Command,
  origin: string,
  result: CloudLoginResult,
): void {
  const payload = {
    outcome: "SUCCESS" as const,
    deviceId: result.deviceId,
    workspaceId: result.workspaceId,
  };
  write(
    io,
    program,
    payload,
    `Logged in to ${origin}. Device ${result.deviceId} is paired.\n`,
  );
}

function writeLogout(
  io: CliIo,
  program: Command,
  result: CloudLogoutResult,
): void {
  write(
    io,
    program,
    { outcome: "SUCCESS" as const, ...result },
    result.revoked ? "Logged out of ToolMirror Cloud.\n" : "Not logged in.\n",
  );
}

function write(
  io: CliIo,
  program: Command,
  payload: Record<string, unknown>,
  human: string,
): void {
  if (program.opts<{ json?: boolean }>().json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
    return;
  }
  io.writeOutput(human);
}

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const processHandle = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  await processHandle.exited.catch(() => undefined);
}
