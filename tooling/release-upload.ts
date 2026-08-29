import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "bun";
import {
  isGitSha,
  listUploadKeys,
  uploadReleaseObjects,
  verifyReleaseLayout,
} from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));
const r2Root = join(root, "dist/r2");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function requiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const version = (
  (await Bun.file(join(root, "package.json")).json()) as { version: string }
).version;
const keys = listUploadKeys(version);
const requireUpload = process.env.RELEASE_REQUIRE_UPLOAD === "1";
const accountId = requiredEnv("R2_ACCOUNT_ID");
const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
const bucket = requiredEnv("R2_BUCKET");

const files = new Map<string, Uint8Array>();
const glob = new Bun.Glob("**/*");
for await (const path of glob.scan({ cwd: r2Root, onlyFiles: true })) {
  files.set(
    path,
    new Uint8Array(await Bun.file(join(r2Root, path)).arrayBuffer()),
  );
}
const expectedSourceSha = process.env.GITHUB_SHA?.trim().toLowerCase();
const layoutErrors = verifyReleaseLayout(
  version,
  files,
  sha256,
  expectedSourceSha && isGitSha(expectedSourceSha)
    ? expectedSourceSha
    : undefined,
);
if (layoutErrors.length > 0) {
  console.error("Release publication blocked; layout verification failed:");
  for (const error of layoutErrors) console.error(`- ${error}`);
  process.exit(1);
}

if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
  if (requireUpload) {
    console.error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required to upload.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `R2 upload skipped (no credentials). Local layout keys:\n${keys.join("\n")}`,
    );
  }
} else {
  const s3 = new S3Client({
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
  });
  await uploadReleaseObjects(
    keys,
    async (key) =>
      new Uint8Array(await Bun.file(join(r2Root, key)).arrayBuffer()),
    async (key, body, type) => {
      await s3.write(key, body, { type });
    },
  );
  console.log(`Uploaded ${keys.length} objects to R2 bucket ${bucket}`);
}
