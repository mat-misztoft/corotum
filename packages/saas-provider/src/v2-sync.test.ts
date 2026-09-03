import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  skillId,
  type V2DesiredState,
  type V2LockedSkill,
} from "../../core/src/index";
import { createArtifactArchive } from "../../skills-adapter/src/artifact-archive";
import { GitSkillMaterializer } from "../../skills-adapter/src/git-source";
import { scanNormalizedContent } from "../../skills-adapter/src/normalized-content";
import { V2CloudNormalSync, V2SaaSProvider } from "./index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-cloud-sync-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Verified artifact\n");
  const archive = await createArtifactArchive(source);
  const id = skillId("sk_cloudsync");
  const { bytes, ...artifact } = archive;
  const lock: V2LockedSkill = {
    id,
    name: "cloud-sync",
    materialization: {
      kind: "artifact",
      artifact: {
        kind: "r2-tar-zst",
        locator: `workspaces/ws_1/artifacts/${id}/${archive.integrityHash}.tar.zst`,
        ...artifact,
      },
    },
  };
  const state: V2DesiredState = {
    manifest: {
      version: 2,
      skills: [
        { id, name: lock.name, targets: "all", resolutionStatus: "RESOLVED" },
      ],
    },
    lockfile: { version: 2, skills: [lock] },
  };
  return { root, archive, id, lock, state };
}

function cloud(state: V2DesiredState, bytes: Uint8Array, reports: unknown[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/state"))
      return Response.json({
        revisionId: "rev_2",
        revisionSequence: 2,
        state,
        dispositionLedger: { version: 2, activeDispositions: {} },
      });
    if (request.url.endsWith("/artifacts")) return new Response(bytes);
    if (request.url.endsWith("/sync-report")) {
      reports.push(await request.json());
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: "rev_2",
        appliedRevisionSequence: 2,
        syncStatus: "SYNCED",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSyncAt: 1,
      });
    }
    throw new Error(`Unexpected URL: ${request.url}`);
  };
}

test("Cloud artifact sync reports SYNCED only after canonical and target verification", async () => {
  const { root, archive, id, state } = await fixture();
  const canonicalRoot = join(root, "canonical");
  const canonical = join(canonicalRoot, "cloud-sync");
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), "# Verified artifact\n");
  const target = join(root, "agent", "cloud-sync");
  await mkdir(join(root, "agent"), { recursive: true });
  await symlink(canonical, target);
  const reports: unknown[] = [];
  const fetch = cloud(state, archive.bytes, reports) as typeof globalThis.fetch;
  const provider = new V2SaaSProvider({
    origin: "https://cloud.invalid",
    workspaceId: "ws_1",
    deviceToken: "secret",
    fetch,
  });
  const result = await new V2CloudNormalSync(provider, {
    origin: "https://cloud.invalid",
    deviceId: "dev_1",
    deviceToken: "secret",
    fetch,
  }).sync({
    lastVerified: {
      appliedRevisionId: "rev_1",
      canonical: {
        [id]: {
          skillId: id,
          path: canonical,
          contentHash: (await scanNormalizedContent(canonical)).contentHash,
        },
      },
    },
    canonicalRoot,
    targets: [{ skillId: id, agentId: "pi", path: target }],
  });
  expect(result.lastVerified.appliedRevisionId).toBe("rev_2");
  expect(result.report).toMatchObject({
    syncStatus: "SYNCED",
    appliedRevisionId: "rev_2",
  });
  expect(reports).toEqual([
    expect.objectContaining({
      syncStatus: "SYNCED",
      targets: [expect.objectContaining({ status: "SYNCED" })],
    }),
  ]);
});

test("private source authentication is reported per target without attempting R2", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-cloud-source-"));
  roots.push(root);
  const id = skillId("sk_privatesource");
  const hash = `sha256:${"a".repeat(64)}` as const;
  const source = {
    repository: "https://example.invalid/private.git",
    path: "skill",
    ref: "main",
    revision: "a".repeat(40),
    contentHash: hash,
  };
  const state: V2DesiredState = {
    manifest: {
      version: 2,
      skills: [
        {
          id,
          name: "private-source",
          targets: "all",
          source: {
            repository: source.repository,
            path: source.path,
            ref: source.ref,
          },
          resolutionStatus: "RESOLVED",
        },
      ],
    },
    lockfile: {
      version: 2,
      skills: [
        {
          id,
          name: "private-source",
          source,
          materialization: { kind: "source", contentHash: hash },
        },
      ],
    },
  };
  const reports: unknown[] = [];
  const fetch = cloud(
    state,
    new Uint8Array(),
    reports,
  ) as typeof globalThis.fetch;
  const git = new GitSkillMaterializer(async () => ({
    exitCode: 128,
    stderr: "terminal prompts disabled",
    stdout: new Uint8Array(),
  }));
  const result = await new V2CloudNormalSync(
    new V2SaaSProvider({
      origin: "https://cloud.invalid",
      workspaceId: "ws_1",
      deviceToken: "secret",
      fetch,
    }),
    {
      origin: "https://cloud.invalid",
      deviceId: "dev_1",
      deviceToken: "secret",
      fetch,
      git,
    },
  ).sync({
    lastVerified: { appliedRevisionId: "rev_1", canonical: {} },
    canonicalRoot: join(root, "canonical"),
    targets: [
      {
        skillId: id,
        agentId: "pi",
        path: join(root, "agent", "private-source"),
      },
    ],
  });
  expect(result.report).toMatchObject({
    syncStatus: "ERROR",
    appliedRevisionId: "rev_1",
    lastErrorCode: "AUTH_REQUIRED",
  });
  expect(reports).toEqual([
    expect.objectContaining({
      targets: [
        expect.objectContaining({
          status: "AUTH_REQUIRED",
          errorCode: "AUTH_REQUIRED",
        }),
      ],
    }),
  ]);
});

test("R2 failure preserves the last verified revision and reports a typed target failure", async () => {
  const { root, archive, id, state } = await fixture();
  const reports: unknown[] = [];
  const fetch = cloud(state, archive.bytes, reports) as typeof globalThis.fetch;
  const failingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return request.url.endsWith("/artifacts")
      ? new Response("gone", { status: 404 })
      : fetch(input, init);
  };
  const provider = new V2SaaSProvider({
    origin: "https://cloud.invalid",
    workspaceId: "ws_1",
    deviceToken: "secret",
    fetch: failingFetch,
  });
  const result = await new V2CloudNormalSync(provider, {
    origin: "https://cloud.invalid",
    deviceId: "dev_1",
    deviceToken: "secret",
    fetch: failingFetch,
  }).sync({
    lastVerified: { appliedRevisionId: "rev_1", canonical: {} },
    canonicalRoot: join(root, "canonical"),
    targets: [
      { skillId: id, agentId: "pi", path: join(root, "agent", "cloud-sync") },
    ],
  });
  expect(result.lastVerified.appliedRevisionId).toBe("rev_1");
  expect(result.report).toMatchObject({
    syncStatus: "ERROR",
    appliedRevisionId: "rev_1",
    lastErrorCode: "ARTIFACT_UNAVAILABLE",
  });
  expect(reports).toEqual([
    expect.objectContaining({
      targets: [
        expect.objectContaining({
          status: "ERROR",
          errorCode: "ARTIFACT_UNAVAILABLE",
        }),
      ],
    }),
  ]);
});
