import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { CLI_VERSION, runCli } from "./cli";
import { applyPendingCliUpdate, createCliUpdateDeps } from "./cli-update";
import { ConfigStore } from "./config";
import { resolvePlatformPaths } from "./platform";
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
const telemetry = new CliTelemetry(
  new ConfigStore(paths),
  {
    confirm: async () => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const response = await prompt.question(
          "Help improve Corotum by sending anonymous usage telemetry?\n● Yes\n○ No\n[Enter] ",
        );
        return !/^(n|no)$/i.test(response.trim());
      } finally {
        prompt.close();
      }
    },
  },
  noOpTelemetryEmitter(),
  { version: CLI_VERSION, os: process.platform, architecture: process.arch },
);

const argv = Bun.argv.slice(2);

if (process.platform === "win32" && !isHelpOrVersionArgv(argv)) {
  try {
    const pending = await applyPendingCliUpdate(
      createCliUpdateDeps({
        currentVersion: CLI_VERSION,
        homeDir: homedir(),
        env: process.env,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    if (pending.status === "failed") {
      process.stderr.write(`${pending.message}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Pending CLI update failed."}\n`,
    );
  }
}

const exitCode = await runCli(argv, undefined, telemetry);
if (exitCode !== 0) process.exitCode = exitCode;
