import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactObject,
  buildLatestJson,
  compiledBinaryName,
  formatChecksums,
  isGitSha,
  RELEASE_TARGETS,
  type ReleaseTarget,
  type ReleaseTargetId,
  sourceMarker,
  UNSIGNED_NOTICE,
  versionDir,
} from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));
const compileDir = join(root, "dist/compile");
const r2Root = join(root, "dist/r2");
const stagingRoot = join(root, "dist/release-staging");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function argValue(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  if (index === -1) return undefined;
  return Bun.argv[index + 1];
}

async function packageJsonVersion(): Promise<string> {
  const pkg = (await Bun.file(join(root, "package.json")).json()) as {
    version: string;
  };
  return pkg.version;
}

async function sourceSha(): Promise<string> {
  const fromEnv = process.env.GITHUB_SHA?.trim().toLowerCase();
  if (fromEnv && isGitSha(fromEnv)) return fromEnv;
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  const sha = out.trim().toLowerCase();
  if (code !== 0 || !isGitSha(sha)) {
    throw new Error("Final release requires the source git SHA");
  }
  return sha;
}

async function compileTarget(target: ReleaseTarget): Promise<string> {
  await mkdir(compileDir, { recursive: true });
  const outfile = join(compileDir, compiledBinaryName(target));
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "apps/cli/src/index.ts",
      "--compile",
      `--target=${target.bunTarget}`,
      `--outfile=${outfile}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    await rm(outfile, { force: true });
    throw new Error(`Failed to compile ${target.bunTarget}`);
  }
  return outfile;
}

async function archiveTarget(
  target: ReleaseTarget,
  binaryPath: string,
  archivePath: string,
): Promise<void> {
  const staging = join(stagingRoot, target.id);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const staged = join(staging, target.binary);
  await Bun.write(staged, Bun.file(binaryPath));
  if (target.binary !== "corotum.exe") {
    const chmod = Bun.spawn(["chmod", "755", staged], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await chmod.exited) !== 0) {
      throw new Error(`Failed to mark ${target.id} executable`);
    }
  }
  await mkdir(join(archivePath, ".."), { recursive: true });
  await rm(archivePath, { force: true });
  const tar = Bun.spawn(
    ["tar", "-czf", archivePath, "-C", staging, target.binary],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  if ((await tar.exited) !== 0) {
    await rm(archivePath, { force: true });
    throw new Error(`Failed to archive ${target.id}`);
  }
}

async function assemble(version: string): Promise<void> {
  await rm(r2Root, { recursive: true, force: true });
  const binariesDir = join(r2Root, versionDir(version), "binaries");
  await mkdir(binariesDir, { recursive: true });

  const sha256ByTarget = {} as Record<ReleaseTargetId, string>;
  const checksumEntries: Array<readonly [string, string]> = [];

  for (const target of RELEASE_TARGETS) {
    const compiled = join(compileDir, compiledBinaryName(target));
    if (!(await Bun.file(compiled).exists())) {
      throw new Error(`Missing compiled binary for ${target.id}: ${compiled}`);
    }
    const archivePath = join(r2Root, artifactObject(version, target.archive));
    await archiveTarget(target, compiled, archivePath);
    const digest = sha256(
      new Uint8Array(await Bun.file(archivePath).arrayBuffer()),
    );
    sha256ByTarget[target.id] = digest;
    checksumEntries.push([digest, `binaries/${target.archive}`]);
  }

  await Bun.write(
    join(r2Root, versionDir(version), "checksums.txt"),
    formatChecksums(version, checksumEntries),
  );
  await Bun.write(
    join(r2Root, versionDir(version), "UNSIGNED"),
    `${UNSIGNED_NOTICE}\n`,
  );
  await Bun.write(
    join(r2Root, versionDir(version), "SOURCE"),
    sourceMarker(await sourceSha()),
  );
  await Bun.write(
    join(r2Root, "releases/latest.json"),
    `${JSON.stringify(buildLatestJson(version, sha256ByTarget), null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const assembleOnly = Bun.argv.includes("--assemble-only");
  const targetName = argValue("--target");
  const version = await packageJsonVersion();

  if (targetName) {
    const target = RELEASE_TARGETS.find(
      (item) => item.bunTarget === targetName,
    );
    if (!target) {
      throw new Error(`Unsupported CLI target: ${targetName}`);
    }
    await mkdir(compileDir, { recursive: true });
    await compileTarget(target);
    return;
  }

  if (!assembleOnly) {
    await rm(r2Root, { recursive: true, force: true });
    await rm(compileDir, { recursive: true, force: true });
    await mkdir(compileDir, { recursive: true });
    for (const target of RELEASE_TARGETS) {
      await compileTarget(target);
    }
  }

  await assemble(version);
  await rm(stagingRoot, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  if (!Bun.argv.includes("--target")) {
    await rm(r2Root, { recursive: true, force: true });
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
