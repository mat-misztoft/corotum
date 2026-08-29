import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { CLI_VERSION, runCli } from "./cli";
import { ConfigStore } from "./config";
import { resolvePlatformPaths } from "./platform";
import { CliTelemetry, noOpTelemetryEmitter } from "./telemetry";

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
          "Help improve ToolMirror by sending anonymous usage telemetry?\n● Yes\n○ No\n[Enter] ",
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

const exitCode = await runCli(Bun.argv.slice(2), undefined, telemetry);
if (exitCode !== 0) process.exitCode = exitCode;
