import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactObject,
  buildLatestJson,
  formatChecksums,
  listUploadKeys,
  PIPELINE_PROOF_NOTES,
  parseChecksums,
  RELEASE_TARGETS,
  type ReleaseTargetId,
  r2ObjectKeys,
  uploadReleaseObjects,
  verifyReleaseLayout,
} from "./release";

const root = fileURLToPath(new URL("..", import.meta.url));

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function fakeArchive(id: string): Uint8Array {
  return new TextEncoder().encode(`pipeline-proof-archive:${id}`);
}

function layoutFiles(
  version: string,
  overrides: Record<string, Uint8Array | undefined> = {},
): Map<string, Uint8Array> {
  const sha256ByTarget = {} as Record<ReleaseTargetId, string>;
  const checksumEntries: Array<readonly [string, string]> = [];
  const files = new Map<string, Uint8Array>();
  for (const target of RELEASE_TARGETS) {
    const bytes = fakeArchive(target.id);
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
    new TextEncoder().encode(
      "ToolMirror v0.1 binaries are unsigned. Signing and notarization are out of scope for v0.1.\n",
    ),
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
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) files.delete(key);
    else files.set(key, value);
  }
  return files;
}

describe("release pipeline proof layout", () => {
  test("covers the v0.1 unsigned matrix and R2 key layout", () => {
    expect(RELEASE_TARGETS.map((target) => target.id)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "windows-x64",
    ]);
    expect(r2ObjectKeys("0.1.0")).toEqual([
      "releases/latest.json",
      "releases/v0.1.0/checksums.txt",
      "releases/v0.1.0/UNSIGNED",
      "releases/v0.1.0/PIPELINE_PROOF",
      "releases/v0.1.0/binaries/toolmirror-darwin-arm64.tar.gz",
      "releases/v0.1.0/binaries/toolmirror-darwin-x64.tar.gz",
      "releases/v0.1.0/binaries/toolmirror-linux-arm64.tar.gz",
      "releases/v0.1.0/binaries/toolmirror-linux-x64.tar.gz",
      "releases/v0.1.0/binaries/toolmirror-windows-x64.tar.gz",
    ]);
  });

  test("accepts a matching unsigned pipeline-proof layout", () => {
    expect(verifyReleaseLayout("0.1.0", layoutFiles("0.1.0"), sha256)).toEqual(
      [],
    );
  });

  test("rejects a missing platform, checksum mismatch, or final marker", () => {
    const missing = layoutFiles("0.1.0", {
      "releases/v0.1.0/binaries/toolmirror-linux-arm64.tar.gz": undefined,
    });
    expect(verifyReleaseLayout("0.1.0", missing, sha256).join("\n")).toContain(
      "missing releases/v0.1.0/binaries/toolmirror-linux-arm64.tar.gz",
    );

    const mismatch = layoutFiles("0.1.0", {
      "releases/v0.1.0/binaries/toolmirror-linux-x64.tar.gz":
        fakeArchive("tampered"),
    });
    expect(verifyReleaseLayout("0.1.0", mismatch, sha256).join("\n")).toContain(
      "checksum mismatch",
    );

    const latest = JSON.parse(
      new TextDecoder().decode(
        layoutFiles("0.1.0").get("releases/latest.json"),
      ),
    );
    latest.final = true;
    latest.channel = "stable";
    const finalized = layoutFiles("0.1.0", {
      "releases/latest.json": new TextEncoder().encode(JSON.stringify(latest)),
    });
    const errors = verifyReleaseLayout("0.1.0", finalized, sha256).join("\n");
    expect(errors).toContain("pipeline-proof");
    expect(errors).toContain("must not be marked final");
  });

  test("parses sha256sum checksums and maps upload keys 1:1 onto R2", async () => {
    const text = formatChecksums("0.1.0", [
      ["a".repeat(64), "binaries/toolmirror-linux-x64.tar.gz"],
    ]);
    expect(
      parseChecksums(text).get("binaries/toolmirror-linux-x64.tar.gz"),
    ).toBe("a".repeat(64));
    const uploaded: string[] = [];
    const keys = listUploadKeys("0.1.0");
    await uploadReleaseObjects(
      keys,
      async (key) => new TextEncoder().encode(key),
      async (key) => {
        uploaded.push(key);
      },
    );
    expect(uploaded).toEqual([...keys]);
  });

  test("GitHub Actions matrix builds every supported target and publishes the R2 layout", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/release.yml"),
      "utf8",
    );
    for (const target of RELEASE_TARGETS) {
      expect(workflow).toContain(target.bunTarget);
      expect(workflow).toContain(target.id);
    }
    expect(workflow).toContain("bun run release:verify");
    expect(workflow).toContain("bun run release:upload");
    expect(workflow).toContain("pipeline-proof");
    expect(workflow).not.toContain("notarytool");
    expect(workflow).not.toContain("codesign");
  });
});
