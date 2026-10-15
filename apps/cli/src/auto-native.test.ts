import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeAutoService } from "./auto-native";

const dirs: string[] = [];
for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} identical install leaves the worker and definition untouched`, async () => {
    const f = await fixture(platform);
    await f.service.install();
    const path =
      platform === "darwin"
        ? join(f.home, "Library/LaunchAgents/com.corotum.auto.plist")
        : join(f.home, ".config/systemd/user/corotum-auto.service");
    const before = await stat(path);
    f.calls.length = 0;
    await f.service.install();
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(f.calls).toEqual(
      platform === "linux"
        ? [["systemctl", "--user", "enable", "corotum-auto.service"]]
        : [],
    );
  });
  test(`${platform} gives a running sync unlimited termination grace`, async () => {
    const f = await fixture(platform);
    await f.service.install();
    const path =
      platform === "darwin"
        ? join(f.home, "Library/LaunchAgents/com.corotum.auto.plist")
        : join(f.home, ".config/systemd/user/corotum-auto.service");
    expect(await readFile(path, "utf8")).toContain(
      platform === "darwin"
        ? "<key>ExitTimeOut</key><integer>0</integer>"
        : "TimeoutStopSec=infinity",
    );
  });
  test(`${platform} replaces an outdated definition`, async () => {
    const f = await fixture(platform);
    await f.service.install();
    const path =
      platform === "darwin"
        ? join(f.home, "Library/LaunchAgents/com.corotum.auto.plist")
        : join(f.home, ".config/systemd/user/corotum-auto.service");
    await writeFile(path, "outdated");
    f.calls.length = 0;
    await f.service.install();
    expect(await readFile(path, "utf8")).not.toBe("outdated");
    expect(f.calls[0]).toEqual(
      platform === "darwin"
        ? ["launchctl", "bootout", "gui/501/com.corotum.auto"]
        : ["systemctl", "--user", "daemon-reload"],
    );
  });
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(platform: "darwin" | "linux" | "win32") {
  const home = await mkdtemp(join(tmpdir(), "auto-native-"));
  dirs.push(home);
  const executable = join(home, 'corotum & "special%');
  await writeFile(executable, "binary");
  const calls: string[][] = [];
  const service = createNativeAutoService({
    platform,
    home,
    executable,
    uid: 501,
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { home, executable, calls, service };
}
test("launchd uses XML escaping, stable executable path and discarded output", async () => {
  const f = await fixture("darwin");
  await f.service.install();
  const text = await readFile(
    join(f.home, "Library/LaunchAgents/com.corotum.auto.plist"),
    "utf8",
  );
  expect(text).toContain("&amp; &quot;special%");
  expect(text).toContain("/dev/null");
  expect(text).toContain("--non-interactive");
  expect(f.calls.flat()).not.toContain("sudo");
  await f.service.remove();
  await f.service.remove();
});
test("systemd quotes specifiers and shell metacharacters without a shell", async () => {
  const f = await fixture("linux");
  await f.service.install();
  const text = await readFile(
    join(f.home, ".config/systemd/user/corotum-auto.service"),
    "utf8",
  );
  expect(text).toContain("special%%");
  expect(text).toContain('\\"');
  expect(text).toContain("StandardOutput=null");
  expect(f.calls[0]).toEqual(["systemctl", "--user", "daemon-reload"]);
  await f.service.start();
  expect(f.calls.at(-1)).toEqual([
    "systemctl",
    "--user",
    "start",
    "corotum-auto.service",
  ]);
});
test("Windows uses encoded PowerShell and least-privilege interactive task", async () => {
  const f = await fixture("win32");
  await f.service.install();
  const script = Buffer.from(f.calls[0]?.at(-1) ?? "", "base64").toString(
    "utf16le",
  );
  expect(script).toContain("Interactive");
  expect(script).toContain("Limited");
  expect(script).toContain("--non-interactive");
  expect(script).toContain("Register-ScheduledTask");
  expect(script).toContain("GetCurrent().User.Value");
});
test("missing installs report stopped and remove is harmless", async () => {
  const f = await fixture("linux");
  expect(await f.service.status()).toEqual({
    installed: false,
    running: false,
    detail: "Not installed",
  });
  await f.service.remove();
  await f.service.stop();
  expect(f.calls).toEqual([]);
});
test("rejects relative paths and definition injection", () => {
  for (const executable of [
    "relative",
    "/tmp/evil\nExecStart=bad",
    "/tmp/bad\0path",
  ]) {
    expect(() => createNativeAutoService({ executable })).toThrow(
      "absolute path",
    );
  }
});
test("systemd reports failure details and active state", async () => {
  const f = await fixture("linux");
  await f.service.install();
  const service = createNativeAutoService({
    platform: "linux",
    home: f.home,
    executable: f.executable,
    run: async () => ({
      code: 0,
      stdout: "ActiveState=active\nSubState=running\nExecMainStatus=0",
      stderr: "",
    }),
  });
  expect((await service.status()).running).toBe(true);
  expect((await service.status()).detail).toContain("ExecMainStatus=0");
});
test("operational errors are not hidden", async () => {
  const f = await fixture("linux");
  const service = createNativeAutoService({
    platform: "linux",
    home: f.home,
    executable: f.executable,
    run: async () => ({ code: 1, stdout: "", stderr: "user bus unavailable" }),
  });
  await expect(service.start()).rejects.toThrow("user bus unavailable");
});
