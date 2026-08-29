import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { MutationLock, MutationLockedError } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";

export const DEFAULT_RELEASE_BASE = "https://releases.toolmirror.com";

export type CliUpdatePlatform = "darwin" | "linux" | "win32";
export type CliUpdateArch = "arm64" | "x64";
export type ReleaseTargetId =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

type ReleaseTarget = Readonly<{
  id: ReleaseTargetId;
  archive: string;
  binary: "toolmirror" | "toolmirror.exe";
}>;

const RELEASE_TARGETS: Readonly<Record<ReleaseTargetId, ReleaseTarget>> = {
  "darwin-arm64": {
    id: "darwin-arm64",
    archive: "toolmirror-darwin-arm64.tar.gz",
    binary: "toolmirror",
  },
  "darwin-x64": {
    id: "darwin-x64",
    archive: "toolmirror-darwin-x64.tar.gz",
    binary: "toolmirror",
  },
  "linux-arm64": {
    id: "linux-arm64",
    archive: "toolmirror-linux-arm64.tar.gz",
    binary: "toolmirror",
  },
  "linux-x64": {
    id: "linux-x64",
    archive: "toolmirror-linux-x64.tar.gz",
    binary: "toolmirror",
  },
  "windows-x64": {
    id: "windows-x64",
    archive: "toolmirror-windows-x64.tar.gz",
    binary: "toolmirror.exe",
  },
};

const latestJsonSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    channel: z.string().min(1),
    unsigned: z.literal(true),
    final: z.boolean(),
    notes: z.string(),
    artifacts: z.record(
      z.string(),
      z
        .object({
          object: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          filename: z.string().regex(/^toolmirror-[a-z0-9-]+\.tar\.gz$/),
          binary: z.enum(["toolmirror", "toolmirror.exe"]),
        })
        .strict(),
    ),
  })
  .strict();

const pendingSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target: z.string().min(1),
  })
  .strict();

export type CliUpdateDeps = Readonly<{
  currentVersion: string;
  platform: CliUpdatePlatform;
  arch: CliUpdateArch;
  executablePath: string;
  pendingDir: string;
  releaseBase: string;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  acquireLock: () => Promise<() => Promise<void>>;
}>;

export type CliUpdateResult = Readonly<{
  status: "UP_TO_DATE" | "AVAILABLE" | "UPDATED" | "STAGED";
  currentVersion: string;
  latestVersion: string;
  target: ReleaseTargetId;
  unsigned: true;
}>;

export type PendingApplyResult = Readonly<
  | { status: "none" }
  | { status: "skipped" }
  | { status: "applied"; version: string }
  | { status: "failed"; message: string }
>;

export function releaseTarget(
  platform: CliUpdatePlatform,
  arch: CliUpdateArch,
): ReleaseTargetId {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error("Windows arm64 is not supported in ToolMirror v0.1.");
    }
    return "windows-x64";
  }
  if (platform === "darwin" || platform === "linux") {
    return `${platform}-${arch}`;
  }
  throw new Error(`Unsupported OS/arch: ${platform}-${arch}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fetchReleaseBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("Failed to download the official ToolMirror release.");
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download the official ToolMirror release (${response.status}).`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createCliUpdateDeps(input: {
  currentVersion: string;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
}): CliUpdateDeps {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? homedir();
  const platform = asPlatform(input.platform ?? process.platform);
  const arch = asArch(input.arch ?? process.arch);
  const paths = resolvePlatformPaths({ homeDir, platform, env });
  const lock = new MutationLock(join(paths.stateDir, "process.lock"));
  return {
    currentVersion: input.currentVersion,
    platform,
    arch,
    executablePath: resolveExecutablePath(platform, homeDir, env),
    pendingDir: join(paths.dataDir, "pending-update"),
    releaseBase: (env.TOOLMIRROR_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(
      /\/$/,
      "",
    ),
    fetchBytes: fetchReleaseBytes,
    acquireLock: () => lock.acquire(),
  };
}

/** Reports official CLI release availability or applies a verified update. */
export async function cliUpdate(
  deps: CliUpdateDeps,
  options: { check: boolean },
): Promise<CliUpdateResult> {
  const target = RELEASE_TARGETS[releaseTarget(deps.platform, deps.arch)];
  const release = await loadVerifiedRelease(deps, target);
  const summary = {
    currentVersion: deps.currentVersion,
    latestVersion: release.version,
    target: target.id,
    unsigned: true as const,
  };
  if (options.check) {
    return {
      ...summary,
      status:
        release.version === deps.currentVersion ? "UP_TO_DATE" : "AVAILABLE",
    };
  }
  if (release.version === deps.currentVersion) {
    return { ...summary, status: "UP_TO_DATE" };
  }

  const unlock = await deps.acquireLock();
  try {
    const archive = await deps.fetchBytes(
      releaseUrl(
        deps.releaseBase,
        `releases/v${release.version}/binaries/${target.archive}`,
      ),
    );
    if (sha256Hex(archive) !== release.sha256) {
      throw new Error(
        "SHA-256 mismatch for the official ToolMirror archive. The existing executable was not replaced.",
      );
    }
    const binary = await extractBinary(archive, target.binary);
    if (deps.platform === "win32") {
      await stageWindowsUpdate(deps, release.version, target.id, binary);
      return { ...summary, status: "STAGED" };
    }
    await replaceExecutable(deps.executablePath, binary);
    return { ...summary, status: "UPDATED" };
  } finally {
    await unlock();
  }
}

/** Applies a previously staged Windows update, preserving the old binary on failure. */
export async function applyPendingCliUpdate(
  deps: CliUpdateDeps,
): Promise<PendingApplyResult> {
  if (deps.platform !== "win32") return { status: "none" };
  const metaPath = pendingMetaPath(deps.pendingDir);
  const exePath = pendingExePath(deps.pendingDir);
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return { status: "none" };
  }

  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await deps.acquireLock();
  } catch (error) {
    if (error instanceof MutationLockedError) return { status: "skipped" };
    throw error;
  }

  try {
    const pending = pendingSchema.parse(JSON.parse(raw));
    const bytes = await readFile(exePath);
    if (sha256Hex(bytes) !== pending.sha256) {
      return {
        status: "failed",
        message:
          "Pending CLI update failed verification. The previous executable was left in place.",
      };
    }
    await replaceWindowsExecutable(deps.executablePath, bytes);
    await rm(exePath, { force: true });
    await rm(metaPath, { force: true });
    return { status: "applied", version: pending.version };
  } catch {
    return {
      status: "failed",
      message:
        "Pending CLI update could not replace the executable. The previous executable was left in place.",
    };
  } finally {
    await unlock?.();
  }
}

function asPlatform(platform: NodeJS.Platform): CliUpdatePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw new Error(`Unsupported OS: ${platform}`);
}

function asArch(arch: string): CliUpdateArch {
  if (arch === "arm64" || arch === "x64") return arch;
  throw new Error(`Unsupported architecture: ${arch}`);
}

function resolveExecutablePath(
  platform: CliUpdatePlatform,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (env.TOOLMIRROR_EXECUTABLE && env.TOOLMIRROR_EXECUTABLE.length > 0) {
    return env.TOOLMIRROR_EXECUTABLE;
  }
  const current = process.execPath;
  const name = current.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (name === "toolmirror" || name === "toolmirror.exe") return current;
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0
        ? env.LOCALAPPDATA
        : join(homeDir, "AppData", "Local");
    return join(localAppData, "ToolMirror", "bin", "toolmirror.exe");
  }
  return join(homeDir, ".local", "bin", "toolmirror");
}

function releaseUrl(base: string, objectPath: string): string {
  return `${base.replace(/\/$/, "")}/${objectPath}`;
}

function malformedMetadata(): Error {
  return new Error(
    "Official release metadata is malformed. The existing executable was not replaced.",
  );
}

async function loadVerifiedRelease(
  deps: CliUpdateDeps,
  target: ReleaseTarget,
): Promise<{ version: string; sha256: string }> {
  let latestBytes: Uint8Array;
  try {
    latestBytes = await deps.fetchBytes(
      releaseUrl(deps.releaseBase, "releases/latest.json"),
    );
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Failed to download the official ToolMirror release.");
  }

  let parsed: z.infer<typeof latestJsonSchema>;
  try {
    parsed = latestJsonSchema.parse(
      JSON.parse(new TextDecoder().decode(latestBytes)),
    );
  } catch {
    throw malformedMetadata();
  }

  const artifact = parsed.artifacts[target.id];
  if (!artifact) throw malformedMetadata();
  const expectedObject = `releases/v${parsed.version}/binaries/${target.archive}`;
  if (
    artifact.filename !== target.archive ||
    artifact.binary !== target.binary ||
    artifact.object !== expectedObject
  ) {
    throw malformedMetadata();
  }

  let checksumBytes: Uint8Array;
  try {
    checksumBytes = await deps.fetchBytes(
      releaseUrl(deps.releaseBase, `releases/v${parsed.version}/checksums.txt`),
    );
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Failed to download the official ToolMirror release.");
  }

  const checksums = parseChecksums(new TextDecoder().decode(checksumBytes));
  const checksum = checksums.get(`binaries/${target.archive}`);
  if (!checksum || checksum !== artifact.sha256) throw malformedMetadata();
  return { version: parsed.version, sha256: artifact.sha256 };
}

function parseChecksums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw malformedMetadata();
    if (
      match[2].includes("..") ||
      match[2].startsWith("/") ||
      match[2].includes("\\")
    ) {
      throw malformedMetadata();
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function extractBinary(
  archive: Uint8Array,
  binaryName: string,
): Promise<Uint8Array> {
  const dir = await mkdtempDir("toolmirror-cli-update-");
  try {
    const archivePath = join(dir, "archive.tar.gz");
    const extractDir = join(dir, "extract");
    await mkdir(extractDir);
    await writeFile(archivePath, archive);
    const tar = Bun.spawn(["tar", "-xzf", archivePath, "-C", extractDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await tar.exited) !== 0) {
      throw new Error("Failed to unpack the official ToolMirror archive.");
    }
    const staged = join(extractDir, binaryName);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(staged);
    } catch {
      throw new Error(`Official archive did not contain ${binaryName}.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Official archive did not contain ${binaryName}.`);
    }
    return await readFile(staged);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mkdtempDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `${prefix}${Math.random().toString(16).slice(2)}${process.pid}`,
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function replaceExecutable(
  dest: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.new`;
  await writeFile(temp, bytes, { mode: 0o755 });
  await rename(temp, dest);
}

async function stageWindowsUpdate(
  deps: CliUpdateDeps,
  version: string,
  target: ReleaseTargetId,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 });
  const exePath = pendingExePath(deps.pendingDir);
  const metaPath = pendingMetaPath(deps.pendingDir);
  await writeFile(exePath, bytes);
  await writeFile(
    metaPath,
    `${JSON.stringify({
      schemaVersion: 1,
      version,
      sha256: sha256Hex(bytes),
      target,
    })}\n`,
  );
}

async function replaceWindowsExecutable(
  dest: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const staged = `${dest}.new`;
  const backup = `${dest}.bak`;
  await writeFile(staged, bytes);
  try {
    await rename(dest, backup);
  } catch {
    await rm(staged, { force: true });
    throw new Error("rename current");
  }
  try {
    await rename(staged, dest);
  } catch {
    await rm(staged, { force: true });
    try {
      await rename(backup, dest);
    } catch {
      await copyFile(backup, dest);
    }
    throw new Error("rename staged");
  }
  await rm(backup, { force: true });
}

function pendingExePath(pendingDir: string): string {
  return join(pendingDir, "toolmirror.exe");
}

function pendingMetaPath(pendingDir: string): string {
  return join(pendingDir, "pending.json");
}
