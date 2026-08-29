import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGitSha, verifyReleaseLayout } from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));
const r2Root = join(root, "dist/r2");
const installSh = join(root, "apps/web/public/install.sh");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function hostTarget(): { os: string; arch: string } | null {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) return null;
  return { os, arch };
}

const pkg = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const files = new Map<string, Uint8Array>();
const glob = new Bun.Glob("**/*");
for await (const path of glob.scan({ cwd: r2Root, onlyFiles: true })) {
  files.set(
    path,
    new Uint8Array(await Bun.file(join(r2Root, path)).arrayBuffer()),
  );
}
const expectedSourceSha = process.env.GITHUB_SHA?.trim().toLowerCase();
const errors = verifyReleaseLayout(
  pkg.version,
  files,
  sha256,
  expectedSourceSha && isGitSha(expectedSourceSha)
    ? expectedSourceSha
    : undefined,
);
if (errors.length > 0) {
  console.error("Installer smoke blocked; layout verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const target = hostTarget();
if (!target) {
  console.error("Installer smoke requires macOS or Linux x64/arm64.");
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const key = new URL(request.url).pathname.replace(/^\//, "");
    const body = files.get(key);
    if (!body) return new Response("not found", { status: 404 });
    return new Response(Buffer.from(body));
  },
});

const home = await mkdtemp(join(tmpdir(), "toolmirror-installer-smoke-"));
try {
  const proc = Bun.spawn(["sh", installSh], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/sh",
      TOOLMIRROR_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
      TOOLMIRROR_OS: target.os,
      TOOLMIRROR_ARCH: target.arch,
      TOOLMIRROR_BIN_DIR: join(home, ".local", "bin"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error(stdout);
    console.error(stderr);
    console.error("Official installer smoke failed.");
    process.exit(1);
  }
  const binary = join(home, ".local", "bin", "toolmirror");
  const versionProc = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [versionOut, versionErr, versionCode] = await Promise.all([
    new Response(versionProc.stdout).text(),
    new Response(versionProc.stderr).text(),
    versionProc.exited,
  ]);
  if (versionCode !== 0 || !versionOut.includes(pkg.version)) {
    console.error(versionOut);
    console.error(versionErr);
    console.error("Installed official binary failed --version.");
    process.exit(1);
  }
  if (!stdout.includes("Official ToolMirror installer")) {
    console.error("Installer did not identify itself as official.");
    process.exit(1);
  }
  console.log(
    `Installer smoke: PASS (${target.os}-${target.arch} v${pkg.version})`,
  );
} finally {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
}
