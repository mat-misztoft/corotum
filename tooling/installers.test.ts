import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactObject,
  buildLatestJson,
  formatChecksums,
  PIPELINE_PROOF_NOTES,
  RELEASE_TARGETS,
  type ReleaseTarget,
  type ReleaseTargetId,
  UNSIGNED_NOTICE,
} from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));
const installSh = join(root, "apps/web/public/install.sh");
const installPs1 = join(root, "apps/web/public/install.ps1");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function chmod755(path: string): Promise<void> {
  const chmod = Bun.spawn(["chmod", "755", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await chmod.exited) !== 0) throw new Error(`chmod failed: ${path}`);
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
    `#!/bin/sh\necho "toolmirror ${version}"\nexit 0\n`,
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
  const code = await tar.exited;
  if (code !== 0) {
    throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
  }
  return new Uint8Array(await Bun.file(archivePath).arrayBuffer());
}

async function releaseLayout(
  version: string,
  stagingRoot: string,
  mutate?: (files: Map<string, Uint8Array>) => void,
): Promise<Map<string, Uint8Array>> {
  const sha256ByTarget = {} as Record<ReleaseTargetId, string>;
  const checksumEntries: Array<readonly [string, string]> = [];
  const files = new Map<string, Uint8Array>();
  for (const target of RELEASE_TARGETS) {
    const bytes = await makeArchive(stagingRoot, target, version);
    const digest = sha256(bytes);
    sha256ByTarget[target.id] = digest;
    checksumEntries.push([digest, `binaries/${target.archive}`]);
    files.set(artifactObject(version, target.archive), bytes);
  }
  files.set(
    `releases/v${version}/checksums.txt`,
    new TextEncoder().encode(formatChecksums(version, checksumEntries)),
  );
  files.set(
    `releases/v${version}/UNSIGNED`,
    new TextEncoder().encode(`${UNSIGNED_NOTICE}\n`),
  );
  files.set(
    `releases/v${version}/PIPELINE_PROOF`,
    new TextEncoder().encode(`${PIPELINE_PROOF_NOTES}\n`),
  );
  files.set(
    "releases/latest.json",
    new TextEncoder().encode(
      `${JSON.stringify(buildLatestJson(version, sha256ByTarget), null, 2)}\n`,
    ),
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

async function runInstallSh(
  home: string,
  origin: string,
  os: string,
  arch: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", installSh], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      TOOLMIRROR_RELEASE_BASE: origin,
      TOOLMIRROR_OS: os,
      TOOLMIRROR_ARCH: arch,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function runWindowsInstallerFixture(
  localAppData: string,
  files: Map<string, Uint8Array>,
  extractRoot: string,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  pathEntries: string[];
}> {
  const stdout: string[] = [
    "Official ToolMirror installer",
    "This is the only officially supported installation method.",
    "Manual binary download is not an officially supported installation method.",
    "v0.1 binaries are unsigned.",
  ];
  const pathFile = join(localAppData, "user-path.txt");
  const dest = join(localAppData, "ToolMirror", "bin", "toolmirror.exe");
  const existing = Bun.file(dest);
  const existingBytes = (await existing.exists())
    ? new Uint8Array(await existing.arrayBuffer())
    : undefined;

  try {
    const latest = JSON.parse(
      new TextDecoder().decode(files.get("releases/latest.json")),
    ) as ReturnType<typeof buildLatestJson>;
    const artifact = latest.artifacts["windows-x64"];
    const archive = files.get(artifact.object);
    if (!archive) throw new Error("missing windows-x64 archive");
    const checksums = new TextDecoder().decode(
      files.get(`releases/v${latest.version}/checksums.txt`),
    );
    const expected = checksums
      .split(/\r?\n/)
      .map((line) =>
        /^([a-f0-9]{64}) {2}binaries\/toolmirror-windows-x64\.tar\.gz$/.exec(
          line,
        ),
      )
      .find((match) => match)?.[1];
    if (!expected) throw new Error("checksums.txt is missing windows-x64");
    if (sha256(archive) !== expected) {
      throw new Error(
        "SHA-256 mismatch for toolmirror-windows-x64.tar.gz. Existing install was not replaced.",
      );
    }
    const extract = join(extractRoot, "windows-extract");
    await rm(extract, { recursive: true, force: true });
    await mkdir(extract, { recursive: true });
    const archivePath = join(extract, artifact.filename);
    await Bun.write(archivePath, archive);
    const tar = Bun.spawn(["tar", "-xzf", archivePath, "-C", extract], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await tar.exited) !== 0) throw new Error("extract failed");
    const staged = join(extract, "toolmirror.exe");
    await chmod755(staged);
    const versionProc = Bun.spawn(["sh", staged, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const versionOut = await new Response(versionProc.stdout).text();
    if ((await versionProc.exited) !== 0) {
      throw new Error(
        "Official binary failed --version. Existing install was not replaced.",
      );
    }
    await mkdir(join(localAppData, "ToolMirror", "bin"), { recursive: true });
    await Bun.write(dest, Bun.file(staged));
    await chmod755(dest);
    const binDir = join(localAppData, "ToolMirror", "bin");
    const current = (await Bun.file(pathFile).exists())
      ? (await Bun.file(pathFile).text())
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
    if (!current.includes(binDir)) current.push(binDir);
    await Bun.write(pathFile, `${current.join(";")}\n`);
    stdout.push(
      `Installed ${dest}`,
      versionOut.trim(),
      "ToolMirror was installed with the official installer.",
    );
    return {
      code: 0,
      stdout: `${stdout.join("\n")}\n`,
      stderr: "",
      pathEntries: current,
    };
  } catch (error) {
    if (existingBytes) await Bun.write(dest, existingBytes);
    return {
      code: 1,
      stdout: `${stdout.join("\n")}\n`,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      pathEntries: (await Bun.file(pathFile).exists())
        ? (await Bun.file(pathFile).text())
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
        : [],
    };
  }
}

const work = await mkdtemp(join(tmpdir(), "toolmirror-installers-"));
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("official installers", () => {
  test("are served as the official install.sh and install.ps1 routes", async () => {
    const sh = await readFile(installSh, "utf8");
    const ps1 = await readFile(installPs1, "utf8");
    for (const source of [sh, ps1]) {
      expect(source).toContain("Official ToolMirror installer");
      expect(source).toContain("only officially supported installation method");
      expect(source).toContain(
        "Manual binary download is not an officially supported installation method.",
      );
      expect(source).toContain("v0.1 binaries are unsigned");
      expect(source).not.toMatch(/download the binary from GitHub/i);
    }
    expect(ps1).toContain("LOCALAPPDATA");
    expect(ps1).toContain("ToolMirror\\bin");
    expect(ps1).toContain("toolmirror.exe");
    expect(ps1).toContain("windows-x64");
    expect(ps1).toContain("Get-FileHash");
    expect(ps1).toContain('GetEnvironmentVariable("Path", "User")');
    expect(ps1).toContain("--version");
    expect(ps1).toContain("Existing install was not replaced");
    expect(ps1).toContain("Windows arm64 is not supported");
  });

  test("selects the matching artifact and installs per-user on every supported OS/arch fixture", async () => {
    const staging = join(work, "archives-all");
    const files = await releaseLayout("0.1.0", staging);
    const server = startReleaseServer(files);
    try {
      for (const target of RELEASE_TARGETS) {
        if (target.id === "windows-x64") {
          const localAppData = join(work, "windows-home", target.id);
          const result = await runWindowsInstallerFixture(
            localAppData,
            files,
            join(work, "windows-extract", target.id),
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toContain("Official ToolMirror installer");
          expect(result.stdout).toContain("Installed");
          const dest = join(
            localAppData,
            "ToolMirror",
            "bin",
            "toolmirror.exe",
          );
          const version = Bun.spawn(["sh", dest, "--version"], {
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(await version.exited).toBe(0);
          expect(await new Response(version.stdout).text()).toBe(
            "toolmirror 0.1.0\n",
          );
          expect(result.pathEntries).toEqual([
            join(localAppData, "ToolMirror", "bin"),
          ]);
          continue;
        }
        const [os, arch] = target.id.split("-");
        const home = join(work, "unix-home", target.id);
        await mkdir(home, { recursive: true });
        const result = await runInstallSh(home, server.origin, os, arch);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Official ToolMirror installer");
        expect(result.stdout).toContain(
          "only officially supported installation method",
        );
        expect(server.requested).toContain(
          `releases/v0.1.0/binaries/${target.archive}`,
        );
        const dest = join(home, ".local/bin/toolmirror");
        const version = Bun.spawn([dest, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await version.exited).toBe(0);
        expect(await new Response(version.stdout).text()).toBe(
          "toolmirror 0.1.0\n",
        );
      }
    } finally {
      server.stop();
    }
  });

  test("aborts a checksum mismatch before replacing an existing binary", async () => {
    const staging = join(work, "archives-mismatch");
    const files = await releaseLayout("0.1.0", staging);
    const home = join(work, "mismatch-home");
    await mkdir(home, { recursive: true });
    const good = startReleaseServer(files);
    try {
      const first = await runInstallSh(home, good.origin, "darwin", "arm64");
      expect(first.code).toBe(0);
    } finally {
      good.stop();
    }
    const dest = join(home, ".local/bin/toolmirror");
    const before = sha256(new Uint8Array(await Bun.file(dest).arrayBuffer()));
    const tampered = await releaseLayout(
      "0.1.0",
      join(work, "archives-tampered"),
      (next) => {
        const junk = new TextEncoder().encode("tampered-archive");
        next.set(
          "releases/v0.1.0/binaries/toolmirror-darwin-arm64.tar.gz",
          junk,
        );
        next.set(
          "releases/v0.1.0/binaries/toolmirror-windows-x64.tar.gz",
          junk,
        );
      },
    );
    const bad = startReleaseServer(tampered);
    try {
      const second = await runInstallSh(home, bad.origin, "darwin", "arm64");
      expect(second.code).not.toBe(0);
      expect(second.stderr).toContain("SHA-256 mismatch");
      expect(second.stderr).toContain("Existing install was not replaced");
      expect(second.stdout).not.toContain("Installed ");
    } finally {
      bad.stop();
    }
    expect(sha256(new Uint8Array(await Bun.file(dest).arrayBuffer()))).toBe(
      before,
    );

    const windowsDir = join(work, "windows-mismatch");
    const firstWin = await runWindowsInstallerFixture(
      windowsDir,
      files,
      join(work, "windows-mismatch-extract-1"),
    );
    expect(firstWin.code).toBe(0);
    const winDest = join(windowsDir, "ToolMirror", "bin", "toolmirror.exe");
    const winBefore = sha256(
      new Uint8Array(await Bun.file(winDest).arrayBuffer()),
    );
    const secondWin = await runWindowsInstallerFixture(
      windowsDir,
      tampered,
      join(work, "windows-mismatch-extract-2"),
    );
    expect(secondWin.code).not.toBe(0);
    expect(secondWin.stderr).toContain("SHA-256 mismatch");
    expect(secondWin.stdout).not.toContain("Installed ");
    expect(sha256(new Uint8Array(await Bun.file(winDest).arrayBuffer()))).toBe(
      winBefore,
    );
  });

  test("re-running the installer does not duplicate PATH entries", async () => {
    const staging = join(work, "archives-path");
    const files = await releaseLayout("0.1.0", staging);
    const server = startReleaseServer(files);
    const home = join(work, "path-home");
    await mkdir(home, { recursive: true });
    try {
      expect(
        (await runInstallSh(home, server.origin, "linux", "x64")).code,
      ).toBe(0);
      expect(
        (await runInstallSh(home, server.origin, "linux", "x64")).code,
      ).toBe(0);
    } finally {
      server.stop();
    }
    const marker = "# Added by the official ToolMirror installer";
    for (const name of [".profile", ".zshrc"]) {
      const text = await readFile(join(home, name), "utf8");
      expect(text.split(marker).length - 1).toBe(1);
      expect(text.split("$HOME/.local/bin").length - 1).toBe(1);
    }
    const windowsDir = join(work, "windows-path");
    const first = await runWindowsInstallerFixture(
      windowsDir,
      files,
      join(work, "windows-path-extract-1"),
    );
    const second = await runWindowsInstallerFixture(
      windowsDir,
      files,
      join(work, "windows-path-extract-2"),
    );
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.pathEntries).toEqual([join(windowsDir, "ToolMirror", "bin")]);
    expect(second.pathEntries).toEqual(first.pathEntries);
  });
});
