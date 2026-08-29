import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isGitSha,
  R2_RELEASE_PREFIX,
  RELEASE_CHANNEL,
  verifyReleaseLayout,
} from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));
const r2Root = join(root, "dist/r2");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function readLayout(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const glob = new Bun.Glob("**/*");
  for await (const path of glob.scan({ cwd: r2Root, onlyFiles: true })) {
    files.set(
      path,
      new Uint8Array(await Bun.file(join(r2Root, path)).arrayBuffer()),
    );
  }
  return files;
}

const pkg = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const files = await readLayout();
const expectedSourceSha = process.env.GITHUB_SHA?.trim().toLowerCase();
if (files.size === 0) {
  console.error(`No release layout at ${r2Root}`);
  process.exitCode = 1;
} else {
  const errors = verifyReleaseLayout(
    pkg.version,
    files,
    sha256,
    expectedSourceSha && isGitSha(expectedSourceSha)
      ? expectedSourceSha
      : undefined,
  );
  if (errors.length > 0) {
    console.error("Release layout verification failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Release layout: PASS (${R2_RELEASE_PREFIX}/v${pkg.version}, unsigned ${RELEASE_CHANNEL} final)`,
    );
  }
}
