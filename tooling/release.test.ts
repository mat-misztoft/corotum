import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLatestJson,
  createReleaseLayout,
  formatChecksums,
  listUploadKeys,
  PIPELINE_PROOF_REUSE_ERROR,
  parseChecksums,
  RELEASE_CHANNEL,
  RELEASE_TARGETS,
  type ReleaseTargetId,
  r2ObjectKeys,
  sourceMarker,
  uploadReleaseObjects,
  verifyReleaseLayout,
} from "./release";
import { emailReleaseConfigurationErrors } from "./release-email-config";
import {
  smokeReleaseManifest,
  smokeWorkerdEndpoints,
} from "./release-endpoints";

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function fakeArchive(id: string): Uint8Array {
  return new TextEncoder().encode(`final-archive:${id}`);
}

function archives(): Record<ReleaseTargetId, Uint8Array> {
  return Object.fromEntries(
    RELEASE_TARGETS.map((target) => [target.id, fakeArchive(target.id)]),
  ) as Record<ReleaseTargetId, Uint8Array>;
}

function layoutFiles(
  version: string,
  overrides: Record<string, Uint8Array | undefined> = {},
): Map<string, Uint8Array> {
  const files = createReleaseLayout(version, archives(), SOURCE_SHA, sha256);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) files.delete(key);
    else files.set(key, value);
  }
  return files;
}

describe("final release layout", () => {
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
      "releases/v0.1.0/SOURCE",
      "releases/v0.1.0/binaries/corotum-darwin-arm64.tar.gz",
      "releases/v0.1.0/binaries/corotum-darwin-x64.tar.gz",
      "releases/v0.1.0/binaries/corotum-linux-arm64.tar.gz",
      "releases/v0.1.0/binaries/corotum-linux-x64.tar.gz",
      "releases/v0.1.0/binaries/corotum-windows-x64.tar.gz",
    ]);
    expect(RELEASE_CHANNEL).toBe("v0.1");
  });

  test("accepts a matching unsigned final layout", () => {
    expect(verifyReleaseLayout("0.1.0", layoutFiles("0.1.0"), sha256)).toEqual(
      [],
    );
  });

  test("rejects a missing platform, checksum mismatch, or pipeline-proof leftover", () => {
    const missing = layoutFiles("0.1.0", {
      "releases/v0.1.0/binaries/corotum-linux-arm64.tar.gz": undefined,
    });
    expect(verifyReleaseLayout("0.1.0", missing, sha256).join("\n")).toContain(
      "missing releases/v0.1.0/binaries/corotum-linux-arm64.tar.gz",
    );

    const mismatch = layoutFiles("0.1.0", {
      "releases/v0.1.0/binaries/corotum-linux-x64.tar.gz":
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
    latest.final = false;
    latest.channel = "pipeline-proof";
    latest.notes = "v0.1 pipeline-proof artifacts. Not a final release.";
    const leftover = layoutFiles("0.1.0", {
      "releases/latest.json": new TextEncoder().encode(JSON.stringify(latest)),
      "releases/v0.1.0/PIPELINE_PROOF": new TextEncoder().encode(
        "Not a final release\n",
      ),
    });
    const errors = verifyReleaseLayout("0.1.0", leftover, sha256).join("\n");
    expect(errors).toContain(PIPELINE_PROOF_REUSE_ERROR);
    expect(errors).toContain("must be marked final");

    const reused = layoutFiles("0.1.0", {
      "releases/v0.1.0/binaries/corotum-linux-x64.tar.gz":
        new TextEncoder().encode("pipeline-proof-archive:linux-x64"),
    });
    expect(verifyReleaseLayout("0.1.0", reused, sha256).join("\n")).toContain(
      PIPELINE_PROOF_REUSE_ERROR,
    );
  });

  test("requires the SOURCE marker to match the final git SHA", () => {
    expect(
      verifyReleaseLayout(
        "0.1.0",
        layoutFiles("0.1.0"),
        sha256,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).join("\n"),
    ).toContain("SOURCE marker does not match the final source SHA");
    expect(sourceMarker(SOURCE_SHA)).toContain("final=true");
  });

  test("parses sha256sum checksums and maps upload keys 1:1 onto R2", async () => {
    const text = formatChecksums("0.1.0", [
      ["a".repeat(64), "binaries/corotum-linux-x64.tar.gz"],
    ]);
    expect(
      parseChecksums(text).get("binaries/corotum-linux-x64.tar.gz"),
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
    expect(keys).not.toContain("releases/v0.1.0/PIPELINE_PROOF");
  });

  test("production email preflight checks the sender, deployed secret name, and EMAIL binding without values", () => {
    const config = { send_email: [{ name: "EMAIL" }] };
    expect(
      emailReleaseConfigurationErrors({
        authEmailFrom: "auth@corotum.com",
        config,
        remoteSecrets: [{ name: "AUTH_EMAIL_FROM" }],
      }),
    ).toEqual([]);
    expect(
      emailReleaseConfigurationErrors({
        authEmailFrom: undefined,
        config: {},
        remoteSecrets: [],
      }),
    ).toEqual([
      "AUTH_EMAIL_FROM is required for the production email release.",
      "EMAIL Worker binding is required for the production email release.",
      "AUTH_EMAIL_FROM is not configured on the deployed Worker.",
    ]);
    expect(
      emailReleaseConfigurationErrors({
        authEmailFrom: "not-an-email",
        config,
        remoteSecrets: [{ name: "AUTH_EMAIL_FROM" }],
      }),
    ).toEqual(["AUTH_EMAIL_FROM must be a valid email address."]);
  });

  test("official CLI scripts and compile proof keep linux-arm64 with existing targets", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const buildCli = readFileSync(join(root, "scripts/build-cli.sh"), "utf8");
    const compileProof = readFileSync(
      join(root, ".github/workflows/cli-compile.yml"),
      "utf8",
    );
    const expectedIds = [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "windows-x64",
    ] as const;

    expect(RELEASE_TARGETS.map((target) => target.id)).toEqual([
      ...expectedIds,
    ]);
    for (const id of expectedIds) {
      expect(pkg.scripts[`build:cli:${id}`]).toBe(
        `./scripts/build-cli.sh bun-${id}`,
      );
      expect(buildCli).toContain(`bun-${id}`);
    }
    expect(pkg.scripts["build:cli:linux"]).toBe(
      "./scripts/build-cli.sh bun-linux-x64",
    );
    expect(compileProof).toContain("bun run build:cli:linux");
    expect(compileProof).toContain("bun run verify:cli dist/corotum-linux-x64");
    expect(compileProof).toContain("bun run build:cli:linux-arm64");
    expect(compileProof).toContain("test -s dist/corotum-linux-arm64");
    expect(compileProof).not.toContain("verify:cli dist/corotum-linux-arm64");
  });

  test("GitHub Actions rebuilds every target from final source and gates publication", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/release.yml"),
      "utf8",
    );
    for (const target of RELEASE_TARGETS) {
      expect(workflow).toContain(target.bunTarget);
      expect(workflow).toContain(target.id);
    }
    expect(workflow).toContain("name: Final release");
    expect(workflow).toContain("bun test");
    expect(workflow).toContain("bun run test:e2e");
    expect(workflow).toContain("bun run web:build");
    expect(workflow).toContain("bun ./tooling/release-build.ts --target");
    expect(workflow).toContain("bun run release:verify");
    expect(workflow).toContain("bun run release:smoke-installers");
    expect(workflow).toContain("bun run web:smoke");
    expect(workflow).toContain("bun run release:deploy");
    expect(workflow).toContain("bun run release:smoke-endpoints");
    expect(workflow).toContain('RELEASE_REQUIRE_UPLOAD: "1"');
    expect(workflow).toContain('RELEASE_REQUIRE_DEPLOY: "1"');
    expect(workflow).toContain(
      "AUTH_EMAIL_FROM: $" + "{{ secrets.AUTH_EMAIL_FROM }}",
    );
    expect(workflow).toContain("pipeline-proof");
    expect(workflow).not.toContain("publish-pipeline-proof");
    expect(workflow).not.toContain("notarytool");
    expect(workflow).not.toContain("codesign");
    expect(workflow).not.toContain("aws s3 cp");
    expect(workflow).not.toContain("r2.dev");
    const testIndex = workflow.indexOf("name: test");
    const buildIndex = workflow.indexOf(
      "bun ./tooling/release-build.ts --target",
    );
    const verifyIndex = workflow.indexOf("bun run release:verify");
    const installerIndex = workflow.indexOf("bun run release:smoke-installers");
    const deployIndex = workflow.indexOf("bun run release:deploy");
    const uploadIndex = workflow.lastIndexOf("bun run release:upload");
    expect(testIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(installerIndex);
    expect(installerIndex).toBeLessThan(deployIndex);
    expect(deployIndex).toBeLessThan(uploadIndex);
  });

  test("workerd and release endpoint smoke reject pipeline-proof leftovers", async () => {
    const responses: Record<string, Response> = {
      "https://corotum.com/api/health": Response.json({ status: "ok" }),
      "https://corotum.com/install.sh": new Response(
        "# Official Corotum installer.\n# v0.1 binaries are unsigned.\n",
      ),
      "https://corotum.com/install.ps1": new Response(
        "# Official Corotum installer\n# v0.1 binaries are unsigned.\n",
      ),
      "https://corotum.com/api/v1/cli/pairings": new Response(
        JSON.stringify({ error: "CLI upgrade required" }),
        { status: 426 },
      ),
      "https://corotum.com/api/auth/get-session": Response.json(null),
      "https://releases.corotum.com/releases/latest.json": Response.json(
        buildLatestJson("0.1.0", {
          "darwin-arm64": "a".repeat(64),
          "darwin-x64": "a".repeat(64),
          "linux-arm64": "a".repeat(64),
          "linux-x64": "a".repeat(64),
          "windows-x64": "a".repeat(64),
        }),
      ),
    };
    const fetchImpl = async (url: string) => {
      const response = responses[url];
      if (!response) return new Response("missing", { status: 404 });
      return response.clone();
    };
    expect(
      await smokeWorkerdEndpoints("https://corotum.com", fetchImpl, {
        requireAuth: true,
        requireCliGate: true,
      }),
    ).toEqual([]);
    expect(
      await smokeReleaseManifest("https://releases.corotum.com", fetchImpl),
    ).toEqual([]);

    responses["https://releases.corotum.com/releases/latest.json"] =
      Response.json({
        channel: "pipeline-proof",
        final: false,
        unsigned: true,
        notes: "pipeline-proof",
        version: "0.1.0",
      });
    expect(
      (
        await smokeReleaseManifest("https://releases.corotum.com", fetchImpl)
      ).join("\n"),
    ).toContain(PIPELINE_PROOF_REUSE_ERROR);
  });
});
