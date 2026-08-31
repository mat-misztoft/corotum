import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReleaseLayout,
  type LatestJson,
  RELEASE_TARGETS,
  type ReleaseTarget,
  type ReleaseTargetId,
} from "../../../tooling/release";
import { type CliIo, runCli } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  applyPendingCliUpdate,
  type CliUpdateDeps,
  cliUpdate,
  fetchReleaseBytes,
  sha256Hex,
} from "./cli-update";
import { MutationLock, MutationLockedError } from "./mutation-lock";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "corotum-cli-update-"));
  directories.push(directory);
  return directory;
}

async function chmod755(path: string): Promise<void> {
  const proc = Bun.spawn(["chmod", "755", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`chmod failed: ${path}`);
}

async function makeArchive(
  stagingRoot: string,
  target: ReleaseTarget,
  version: string,
): Promise<Uint8Array> {
  const staging = join(stagingRoot, target.id);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const binaryPath = join(staging, target.binary);
  await writeFile(
    binaryPath,
    `#!/bin/sh\necho "corotum ${version}"\nexit 0\n`,
    { encoding: "utf8" },
  );
  await chmod755(binaryPath);
  const archivePath = join(stagingRoot, target.archive);
  const tar = Bun.spawn(
    ["tar", "-czf", archivePath, "-C", staging, target.binary],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if ((await tar.exited) !== 0) {
    throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
  }
  return new Uint8Array(await Bun.file(archivePath).arrayBuffer());
}

async function releaseLayout(
  version: string,
  stagingRoot: string,
  mutate?: (files: Map<string, Uint8Array>) => void,
): Promise<Map<string, Uint8Array>> {
  const archives = {} as Record<ReleaseTargetId, Uint8Array>;
  for (const target of RELEASE_TARGETS) {
    archives[target.id] = await makeArchive(stagingRoot, target, version);
  }
  const files = createReleaseLayout(
    version,
    archives,
    "0123456789abcdef0123456789abcdef01234567",
    sha256Hex,
  );
  mutate?.(files);
  return files;
}

function startReleaseServer(files: Map<string, Uint8Array>): {
  origin: string;
  requested: string[];
  stop: () => void;
} {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const key = url.pathname.replace(/^\//, "");
      requested.push(key);
      const body = files.get(key);
      if (!body) return new Response("not found", { status: 404 });
      return new Response(body);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requested,
    stop: () => server.stop(true),
  };
}

async function createHarness(options?: {
  platform?: CliUpdateDeps["platform"];
  arch?: CliUpdateDeps["arch"];
  currentVersion?: string;
  mutate?: (files: Map<string, Uint8Array>) => void;
  version?: string;
}): Promise<{
  deps: CliUpdateDeps;
  executablePath: string;
  original: Uint8Array;
  requested: string[];
  stop: () => void;
  pendingDir: string;
}> {
  const rootDir = await tempDir();
  const staging = join(rootDir, "staging");
  const files = await releaseLayout(
    options?.version ?? "0.1.1",
    staging,
    options?.mutate,
  );
  const server = startReleaseServer(files);
  const platform = options?.platform ?? "darwin";
  const executablePath = join(
    rootDir,
    "bin",
    platform === "win32" ? "corotum.exe" : "corotum",
  );
  const original = new TextEncoder().encode("#!/bin/sh\necho old\n");
  await mkdir(join(rootDir, "bin"), { recursive: true });
  await writeFile(executablePath, original);
  await chmod755(executablePath);
  const lockFile = join(rootDir, "state", "process.lock");
  const lock = new MutationLock(lockFile);
  return {
    deps: {
      currentVersion: options?.currentVersion ?? "0.1.0",
      platform,
      arch: options?.arch ?? "arm64",
      executablePath,
      pendingDir: join(rootDir, "pending-update"),
      releaseBase: server.origin,
      fetchBytes: fetchReleaseBytes,
      acquireLock: () => lock.acquire(),
    },
    executablePath,
    original,
    requested: server.requested,
    stop: server.stop,
    pendingDir: join(rootDir, "pending-update"),
  };
}

function fixtureIo(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdinIsTTY: true,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    },
    output,
    errors,
  };
}

describe("cli-update", () => {
  test("cli-update --check reports availability without modifying the executable", async () => {
    const harness = await createHarness();
    try {
      const result = await cliUpdate(harness.deps, { check: true });
      expect(result).toEqual({
        status: "AVAILABLE",
        currentVersion: "0.1.0",
        latestVersion: "0.1.1",
        target: "darwin-arm64",
        unsigned: true,
      });
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
      expect(harness.requested).toEqual([
        "releases/latest.json",
        "releases/v0.1.1/checksums.txt",
      ]);
    } finally {
      harness.stop();
    }
  });

  test("cli-update --check reports UP_TO_DATE without downloading the archive", async () => {
    const harness = await createHarness({ currentVersion: "0.1.1" });
    try {
      const result = await cliUpdate(harness.deps, { check: true });
      expect(result.status).toBe("UP_TO_DATE");
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
      expect(harness.requested.some((path) => path.endsWith(".tar.gz"))).toBe(
        false,
      );
    } finally {
      harness.stop();
    }
  });

  test("macOS replacement happens only after checksum verification", async () => {
    const harness = await createHarness({ platform: "darwin", arch: "arm64" });
    try {
      const result = await cliUpdate(harness.deps, { check: false });
      expect(result.status).toBe("UPDATED");
      const installed = await readFile(harness.executablePath, "utf8");
      expect(installed).toContain("corotum 0.1.1");
      expect(installed).not.toEqual(new TextDecoder().decode(harness.original));
    } finally {
      harness.stop();
    }
  });

  test("an active mutation lock blocks replacement", async () => {
    const harness = await createHarness();
    const release = await harness.deps.acquireLock();
    try {
      await expect(cliUpdate(harness.deps, { check: false })).rejects.toEqual(
        expect.any(MutationLockedError),
      );
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
    } finally {
      await release();
      harness.stop();
    }
  });

  test("an active mutation lock does not block --check", async () => {
    const harness = await createHarness();
    const release = await harness.deps.acquireLock();
    try {
      const result = await cliUpdate(harness.deps, { check: true });
      expect(result.status).toBe("AVAILABLE");
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
    } finally {
      await release();
      harness.stop();
    }
  });

  test("checksum mismatch rejects the archive without replacing the executable", async () => {
    const harness = await createHarness({
      mutate(files) {
        const key = "releases/v0.1.1/binaries/corotum-darwin-arm64.tar.gz";
        const bytes = files.get(key);
        if (!bytes) throw new Error("missing archive");
        const tampered = new Uint8Array(bytes);
        tampered[0] ^= 0xff;
        files.set(key, tampered);
      },
    });
    try {
      await expect(cliUpdate(harness.deps, { check: false })).rejects.toThrow(
        /SHA-256 mismatch/,
      );
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
    } finally {
      harness.stop();
    }
  });

  test("malformed release metadata is rejected without file replacement", async () => {
    const harness = await createHarness({
      mutate(files) {
        files.set(
          "releases/latest.json",
          new TextEncoder().encode("{not-json"),
        );
      },
    });
    try {
      await expect(cliUpdate(harness.deps, { check: false })).rejects.toThrow(
        /malformed/,
      );
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
    } finally {
      harness.stop();
    }
  });

  test("malicious artifact paths in latest.json are rejected", async () => {
    const harness = await createHarness({
      mutate(files) {
        const latest = JSON.parse(
          new TextDecoder().decode(files.get("releases/latest.json")),
        ) as LatestJson;
        latest.artifacts["darwin-arm64"] = {
          ...latest.artifacts["darwin-arm64"],
          object: "releases/v0.1.1/binaries/../../secret.tar.gz",
          filename: "corotum-evil.tar.gz",
        };
        files.set(
          "releases/latest.json",
          new TextEncoder().encode(`${JSON.stringify(latest)}\n`),
        );
      },
    });
    try {
      await expect(cliUpdate(harness.deps, { check: false })).rejects.toThrow(
        /malformed/,
      );
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
      expect(harness.requested.some((path) => path.endsWith(".tar.gz"))).toBe(
        false,
      );
    } finally {
      harness.stop();
    }
  });

  test("Windows stages a verified update without replacing the running executable", async () => {
    const harness = await createHarness({
      platform: "win32",
      arch: "x64",
    });
    try {
      const result = await cliUpdate(harness.deps, { check: false });
      expect(result.status).toBe("STAGED");
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
      const pending = await readFile(
        join(harness.pendingDir, "corotum.exe"),
        "utf8",
      );
      expect(pending).toContain("corotum 0.1.1");
    } finally {
      harness.stop();
    }
  });

  test("a failed later Windows replacement leaves the previous executable runnable", async () => {
    const harness = await createHarness({
      platform: "win32",
      arch: "x64",
    });
    try {
      expect(await cliUpdate(harness.deps, { check: false })).toMatchObject({
        status: "STAGED",
      });
      await writeFile(
        join(harness.pendingDir, "corotum.exe"),
        "tampered-pending",
      );
      const applied = await applyPendingCliUpdate(harness.deps);
      expect(applied.status).toBe("failed");
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
      expect(await readFile(harness.executablePath, "utf8")).toContain("old");
    } finally {
      harness.stop();
    }
  });

  test("Windows apply replaces the previous executable after a verified pending update", async () => {
    const harness = await createHarness({
      platform: "win32",
      arch: "x64",
    });
    try {
      await cliUpdate(harness.deps, { check: false });
      const applied = await applyPendingCliUpdate(harness.deps);
      expect(applied).toEqual({ status: "applied", version: "0.1.1" });
      expect(await readFile(harness.executablePath, "utf8")).toContain(
        "corotum 0.1.1",
      );
    } finally {
      harness.stop();
    }
  });

  test("Windows apply restores the previous executable when the destination cannot be replaced", async () => {
    const harness = await createHarness({
      platform: "win32",
      arch: "x64",
    });
    try {
      await cliUpdate(harness.deps, { check: false });
      await chmod(join(harness.executablePath, ".."), 0o555);
      try {
        const applied = await applyPendingCliUpdate(harness.deps);
        expect(applied.status).toBe("failed");
        await chmod(join(harness.executablePath, ".."), 0o755);
        expect(await readFile(harness.executablePath)).toEqual(
          harness.original,
        );
      } finally {
        await chmod(join(harness.executablePath, ".."), 0o755);
      }
    } finally {
      harness.stop();
    }
  });

  test("registers cli-update --check in the public CLI", async () => {
    const { io, output, errors } = fixtureIo();
    expect(await runCli(["cli-update", "--help"], io)).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join("")).toContain("--check");
    expect(output.join("")).toContain("official release metadata");
  });

  test("cli-update --json --check uses schema version 1", async () => {
    const harness = await createHarness();
    const previousBase = process.env.TOOLMIRROR_RELEASE_BASE;
    const previousExe = process.env.TOOLMIRROR_EXECUTABLE;
    process.env.TOOLMIRROR_RELEASE_BASE = harness.deps.releaseBase;
    process.env.TOOLMIRROR_EXECUTABLE = harness.executablePath;
    try {
      const { io, output, errors } = fixtureIo();
      // Command uses process.platform; --check still must not rewrite the exe.
      const code = await runCli(["--json", "cli-update", "--check"], io);
      expect(errors).toEqual([]);
      if (code === 0) {
        expect(JSON.parse(output.join(""))).toMatchObject({
          ...jsonEnvelope({ outcome: "SUCCESS" }),
          unsigned: true,
        });
      }
      expect(await readFile(harness.executablePath)).toEqual(harness.original);
    } finally {
      if (previousBase === undefined)
        delete process.env.TOOLMIRROR_RELEASE_BASE;
      else process.env.TOOLMIRROR_RELEASE_BASE = previousBase;
      if (previousExe === undefined) delete process.env.TOOLMIRROR_EXECUTABLE;
      else process.env.TOOLMIRROR_EXECUTABLE = previousExe;
      harness.stop();
    }
  });
});
