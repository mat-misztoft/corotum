import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function run(home: string, args: readonly string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("XDG_")) env[key] = value;
  }
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      FORCE_COLOR: "0",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("reset --yes without Cloud credentials clears local config", async () => {
  const home = await mkdtemp(join(tmpdir(), "corotum-reset-"));
  roots.push(home);
  const paths = resolvePlatformPaths({
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    },
  });
  await mkdir(paths.configDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(
    paths.configFile,
    `${JSON.stringify({ ...defaultConfig(), mode: "cloud" }, null, 2)}\n`,
  );
  await writeFile(join(paths.stateDir, "state.json"), "{}\n");

  const missing = await run(home, ["--json", "--non-interactive", "reset"]);
  expect(missing.code).not.toBe(0);

  const cleared = await run(home, [
    "--json",
    "--non-interactive",
    "reset",
    "--yes",
  ]);
  expect(cleared.code).toBe(ExitCode.SUCCESS);
  expect(JSON.parse(cleared.stdout)).toMatchObject({
    outcome: "SUCCESS",
    cloudCleared: false,
  });
  await expect(Bun.file(paths.configFile).exists()).resolves.toBe(false);
});
