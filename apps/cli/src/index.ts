import { homedir } from "node:os";
import { join } from "node:path";
import { restartAutoSyncService } from "./auto-command";
import { runAutoSyncAwareCommand } from "./auto-sync";
import { CLI_VERSION, runCli } from "./cli";
import { applyPendingCliUpdate, createCliUpdateDeps } from "./cli-update";
import { ConfigStore, CredentialsStore } from "./config";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { confirmOption } from "./prompts";
import {
  CliTelemetry,
  isHelpOrVersionArgv,
  noOpTelemetryEmitter,
} from "./telemetry";

const paths = resolvePlatformPaths({
  homeDir: homedir(),
  platform: process.platform as "darwin" | "linux" | "win32",
  env: process.env,
});
const configStore = new ConfigStore(paths);
const telemetry = new CliTelemetry(
  {
    load: () => configStore.load(),
    set: async (key, value) => {
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        return await configStore.set(key, value);
      } finally {
        await release();
      }
    },
  },
  {
    confirm: () =>
      confirmOption(
        "Help improve Corotum by sending anonymous usage telemetry?",
        true,
      ),
  },
  noOpTelemetryEmitter(),
  { version: CLI_VERSION, os: process.platform, architecture: process.arch },
);

const argv = Bun.argv.slice(2);
let pendingUpdateApplied = false;
let updatedExecutable = process.execPath;

if (process.platform === "win32" && !isHelpOrVersionArgv(argv)) {
  try {
    const updateDeps = createCliUpdateDeps({
      currentVersion: CLI_VERSION,
      homeDir: homedir(),
      env: process.env,
      platform: process.platform,
      arch: process.arch,
    });
    const pending = await applyPendingCliUpdate(updateDeps);
    updatedExecutable = updateDeps.executablePath;
    if (pending.status === "failed") {
      process.stderr.write(`${pending.message}\n`);
    }
    pendingUpdateApplied = pending.status === "applied";
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Pending CLI update failed."}\n`,
    );
  }
}

const credentials = new CredentialsStore(paths);
const exitCode = await runAutoSyncAwareCommand({
  pendingUpdateApplied,
  loadToken: async () =>
    !isHelpOrVersionArgv(argv) &&
    (argv.includes("login") || argv.includes("init"))
      ? (await credentials.load()).cloudDeviceToken
      : undefined,
  restart: restartAutoSyncService,
  run: () => runCli(argv, undefined, telemetry),
  // Keep Task Scheduler's task alive without stopping our own worker process.
  runUpdatedWorker: argv.some(
    (arg, index) => arg === "auto" && argv[index + 1] === "run",
  )
    ? () =>
        Bun.spawn([updatedExecutable, ...argv], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).exited
    : undefined,
});
if (exitCode !== 0) process.exitCode = exitCode;
