import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { skillId } from "../../../packages/core/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
} from "../../../packages/saas-provider/src/index";
import {
  type ArtifactBucket,
  cloudArtifactLocator,
  memoryArtifactBucket,
} from "./artifacts";
import {
  ARTIFACT_DESCRIPTOR_HEADER,
  handleGetWorkspaceArtifact,
  handlePostWorkspaceArtifactGc,
  handlePutWorkspaceArtifact,
} from "./artifacts-http";
import { approvePairing, createPairing } from "./pairings";
import { handlePutWorkspaceState } from "./state-http";
import { issueDeviceToken, type TokenDatabase } from "./tokens";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const device = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};
const skill = skillId("sk_01JArtifactA");
const otherSkill = skillId("sk_01JArtifactB");
const hash = (bytes: Uint8Array) => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `sha256:${hasher.digest("hex")}` as const;
};

async function artifactDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  const db: TokenDatabase = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.query(query).get(...values) as T) ?? null;
            },
            async run() {
              const result = sqlite.query(query).run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T>() {
              return { results: sqlite.query(query).all(...values) as T[] };
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db };
}

async function pairedDevice(
  db: TokenDatabase,
  sqlite: Database,
  user = { id: "user_1", email: "ada@example.com" },
) {
  sqlite
    .query(
      "INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(user.id, "Ada", user.email, Date.now(), Date.now());
  const pairing = await createPairing(db, device, 1_000);
  await approvePairing(db, user.id, pairing.id, pairing.userCode, 2_000);
  const issued = await issueDeviceToken(db, pairing.id, pairing.deviceCode, 3_000);
  return { issued, workspaceId: issued.workspaceId as string };
}

function apiRequest(path: string, token: string, init?: ConstructorParameters<typeof Request>[1]) {
  return new Request(`https://corotum.com${path}`, {
    ...init,
    headers: {
      [CLI_VERSION_HEADER]: "0.1.0",
      [DEVICE_TOKEN_HEADER]: token,
      ...(init?.headers ?? {}),
    },
  });
}

async function pack(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "corotum-r2-"));
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  const archive = await createArtifactArchive(root);
  await rm(root, { force: true, recursive: true });
  return archive;
}

function transfer(
  workspaceId: string,
  skillId: string,
  archive: Awaited<ReturnType<typeof pack>>,
) {
  return {
    skillId,
    artifact: {
      kind: "r2-tar-zst" as const,
      contentHash: archive.contentHash,
      integrityHash: archive.integrityHash,
      locator: cloudArtifactLocator(workspaceId, skillId, archive.integrityHash),
      sizeBytes: archive.sizeBytes,
    },
  };
}

function artifactRequest(
  workspaceId: string,
  token: string,
  descriptor: ReturnType<typeof transfer>,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return apiRequest(`/api/v1/workspaces/${workspaceId}/artifacts`, token, {
    ...init,
    headers: {
      [ARTIFACT_DESCRIPTOR_HEADER]: JSON.stringify(descriptor),
      ...(init?.headers ?? {}),
    },
  });
}

const source = "https://github.com/example/skills.git";
const sourceState = {
  manifest: {
    version: 2 as const,
    skills: [{
      id: skill,
      name: "review",
      targets: "all" as const,
      source: { repository: source, path: "skills/review", ref: "main" },
      resolutionStatus: "RESOLVED" as const,
    }],
  },
  lockfile: {
    version: 2 as const,
    skills: [{
      id: skill,
      name: "review",
      source: { repository: source, path: "skills/review", ref: "main", revision: "a".repeat(40), contentHash: `sha256:${"b".repeat(64)}` as const },
      materialization: { kind: "source" as const, contentHash: `sha256:${"b".repeat(64)}` as const },
    }],
  },
};

function artifactState(workspaceId: string, skillId: string, archive: Awaited<ReturnType<typeof pack>>) {
  const descriptor = transfer(workspaceId, skillId, archive);
  return {
    descriptor,
    state: {
      manifest: {
        version: 2 as const,
        skills: [{ id: skillId, name: skillId === skill ? "review" : "notes", targets: "all" as const, resolutionStatus: "RESOLVED" as const }],
      },
      lockfile: {
        version: 2 as const,
        skills: [{
          id: skillId,
          name: skillId === skill ? "review" : "notes",
          materialization: { kind: "artifact" as const, artifact: descriptor.artifact },
        }],
      },
    },
  };
}

async function publish(
  db: TokenDatabase,
  workspaceId: string,
  token: string,
  state: unknown,
  baseRevision: string | null,
  idempotencyKey: string,
) {
  return handlePutWorkspaceState(
    apiRequest(`/api/v1/workspaces/${workspaceId}/state`, token, {
      method: "PUT",
      body: JSON.stringify({
        state,
        baseRevision,
        idempotencyKey,
        transition: { type: "ADD", skillId: skill, metadata: {} },
      }),
    }),
    db,
    workspaceId,
  );
}

test("authenticated upload and download verify hashes, isolate workspaces, and reject source locks", async () => {
  const { sqlite, db } = await artifactDb();
  const first = await pairedDevice(db, sqlite);
  const second = await pairedDevice(db, sqlite, { id: "user_2", email: "bob@example.com" });
  const bucket = memoryArtifactBucket();
  const archive = await pack({ "SKILL.md": "# review\n" });
  const descriptor = transfer(first.workspaceId, skill, archive);

  const uploaded = await handlePutWorkspaceArtifact(
    artifactRequest(first.workspaceId, first.issued.token, descriptor, { method: "PUT", body: archive.bytes }),
    db,
    bucket,
    first.workspaceId,
  );
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toEqual(descriptor);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get()).toEqual({ count: 1 });
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get()).toEqual({ count: 0 });

  const downloaded = await handleGetWorkspaceArtifact(
    artifactRequest(first.workspaceId, first.issued.token, descriptor),
    db,
    bucket,
    first.workspaceId,
  );
  expect(downloaded.status).toBe(200);
  expect(hash(new Uint8Array(await downloaded.arrayBuffer()))).toBe(archive.integrityHash);

  const crossed = await handleGetWorkspaceArtifact(
    artifactRequest(second.workspaceId, second.issued.token, {
      ...descriptor,
      artifact: { ...descriptor.artifact, locator: cloudArtifactLocator(second.workspaceId, skill, archive.integrityHash) },
    }),
    db,
    bucket,
    second.workspaceId,
  );
  expect(crossed.status).toBe(404);
  expect(bucket.objects.has(descriptor.artifact.locator)).toBe(true);
  expect(bucket.objects.has(cloudArtifactLocator(second.workspaceId, skill, archive.integrityHash))).toBe(false);

  const stolen = await handleGetWorkspaceArtifact(
    artifactRequest(first.workspaceId, second.issued.token, descriptor),
    db,
    bucket,
    first.workspaceId,
  );
  expect(stolen.status).toBe(404);

  await publish(db, first.workspaceId, first.issued.token, sourceState, null, "source-1");
  const sourceUpload = await handlePutWorkspaceArtifact(
    artifactRequest(first.workspaceId, first.issued.token, descriptor, { method: "PUT", body: archive.bytes }),
    db,
    bucket,
    first.workspaceId,
  );
  expect(sourceUpload.status).toBe(400);
  expect(await sourceUpload.json()).toEqual({
    error: "Source-backed locks cannot upload a Cloud content artifact.",
  });
});

test("upload failure leaves no published reference and a metadata retry is idempotent", async () => {
  const { sqlite, db } = await artifactDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);
  const bucket = memoryArtifactBucket();
  const archive = await pack({ "SKILL.md": "# keep\n" });
  const descriptor = transfer(workspaceId, skill, archive);
  let failMetadata = true;
  const flaky: TokenDatabase = {
    prepare(query: string) {
      if (failMetadata && query.includes("INSERT OR IGNORE INTO workspace_artifacts")) {
        return {
          bind() {
            return {
              async first() { return null; },
              async run() { throw new Error("metadata write failed"); },
              async all() { return { results: [] }; },
            };
          },
        };
      }
      return db.prepare(query);
    },
    batch: db.batch.bind(db),
  };

  const failed = await handlePutWorkspaceArtifact(
    artifactRequest(workspaceId, issued.token, descriptor, { method: "PUT", body: archive.bytes }),
    flaky,
    bucket,
    workspaceId,
  );
  expect(failed.status).toBe(503);
  expect(bucket.objects.has(descriptor.artifact.locator)).toBe(true);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get()).toEqual({ count: 0 });
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get()).toEqual({ count: 0 });

  failMetadata = false;
  const retried = await handlePutWorkspaceArtifact(
    artifactRequest(workspaceId, issued.token, descriptor, { method: "PUT", body: archive.bytes }),
    db,
    bucket,
    workspaceId,
  );
  expect(retried.status).toBe(200);
  expect(sqlite.query("SELECT locator FROM workspace_artifacts").get()).toEqual({
    locator: descriptor.artifact.locator,
  });
});

test("GC retains current plus previous artifacts and deletes nothing when listing or references are ambiguous", async () => {
  const { sqlite, db } = await artifactDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);
  const bucket = memoryArtifactBucket();
  const firstArchive = await pack({ "SKILL.md": "# one\n" });
  const secondArchive = await pack({ "SKILL.md": "# two\n" });
  const thirdArchive = await pack({ "SKILL.md": "# three\n" });
  const unpublished = await pack({ "SKILL.md": "# pending\n" });
  const first = artifactState(workspaceId, skill, firstArchive);
  const second = artifactState(workspaceId, skill, secondArchive);
  const third = artifactState(workspaceId, skill, thirdArchive);
  const pending = transfer(workspaceId, otherSkill, unpublished);

  for (const item of [
    { archive: firstArchive, descriptor: first.descriptor },
    { archive: secondArchive, descriptor: second.descriptor },
    { archive: thirdArchive, descriptor: third.descriptor },
    { archive: unpublished, descriptor: pending },
  ]) {
    expect((await handlePutWorkspaceArtifact(
      artifactRequest(workspaceId, issued.token, item.descriptor, { method: "PUT", body: item.archive.bytes }),
      db,
      bucket,
      workspaceId,
    )).status).toBe(200);
  }

  const rev1 = await publish(db, workspaceId, issued.token, first.state, null, "art-1");
  expect(rev1.status).toBe(200);
  const rev1Body = await rev1.json() as { revisionId: string };
  const rev2 = await publish(db, workspaceId, issued.token, second.state, rev1Body.revisionId, "art-2");
  expect(rev2.status).toBe(200);
  const rev2Body = await rev2.json() as { revisionId: string };
  const rev3 = await publish(db, workspaceId, issued.token, third.state, rev2Body.revisionId, "art-3");
  expect(rev3.status).toBe(200);

  const collected = await handlePostWorkspaceArtifactGc(
    apiRequest(`/api/v1/workspaces/${workspaceId}/artifacts/gc`, issued.token, { method: "POST" }),
    db,
    bucket,
    workspaceId,
  );
  expect(collected.status).toBe(200);
  expect(await collected.json()).toEqual({ deleted: [first.descriptor] });
  expect(bucket.objects.has(first.descriptor.artifact.locator)).toBe(false);
  expect(bucket.objects.has(second.descriptor.artifact.locator)).toBe(true);
  expect(bucket.objects.has(third.descriptor.artifact.locator)).toBe(true);
  expect(bucket.objects.has(pending.artifact.locator)).toBe(true);
  expect(
    new Set(
      sqlite.query("SELECT integrity_hash AS hash FROM workspace_artifacts").all().map((row) => (row as { hash: string }).hash),
    ),
  ).toEqual(new Set([secondArchive.integrityHash, thirdArchive.integrityHash, unpublished.integrityHash]));

  const missingRetained = memoryArtifactBucket();
  missingRetained.objects.set(second.descriptor.artifact.locator, secondArchive.bytes.slice());
  const ambiguousMissing = await handlePostWorkspaceArtifactGc(
    apiRequest(`/api/v1/workspaces/${workspaceId}/artifacts/gc`, issued.token, { method: "POST" }),
    db,
    missingRetained,
    workspaceId,
  );
  expect(ambiguousMissing.status).toBe(409);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get()).toEqual({ count: 3 });

  const truncated: ArtifactBucket = {
    async put() {},
    async get() { return null; },
    async list() { return { keys: [], truncated: true }; },
    async delete() { throw new Error("must not delete"); },
  };
  const ambiguousList = await handlePostWorkspaceArtifactGc(
    apiRequest(`/api/v1/workspaces/${workspaceId}/artifacts/gc`, issued.token, { method: "POST" }),
    db,
    truncated,
    workspaceId,
  );
  expect(ambiguousList.status).toBe(409);

  sqlite.query("UPDATE workspace_artifacts SET locator = ? WHERE integrity_hash = ?").run(
    "workspaces/other/artifacts/x",
    thirdArchive.integrityHash,
  );
  const ambiguousLocator = await handlePostWorkspaceArtifactGc(
    apiRequest(`/api/v1/workspaces/${workspaceId}/artifacts/gc`, issued.token, { method: "POST" }),
    db,
    bucket,
    workspaceId,
  );
  expect(ambiguousLocator.status).toBe(409);
  expect(bucket.objects.has(second.descriptor.artifact.locator)).toBe(true);
  expect(bucket.objects.has(third.descriptor.artifact.locator)).toBe(true);
});

test("corrupt archives are rejected on transfer and never published", async () => {
  const { sqlite, db } = await artifactDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);
  const bucket = memoryArtifactBucket();
  const archive = await pack({ "SKILL.md": "# ok\n" });
  const descriptor = transfer(workspaceId, skill, archive);
  const corrupt = Uint8Array.from(archive.bytes);
  corrupt[0] ^= 1;

  const upload = await handlePutWorkspaceArtifact(
    artifactRequest(workspaceId, issued.token, descriptor, { method: "PUT", body: corrupt }),
    db,
    bucket,
    workspaceId,
  );
  expect(upload.status).toBe(400);
  expect(bucket.objects.size).toBe(0);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get()).toEqual({ count: 0 });

  expect((await handlePutWorkspaceArtifact(
    artifactRequest(workspaceId, issued.token, descriptor, { method: "PUT", body: archive.bytes }),
    db,
    bucket,
    workspaceId,
  )).status).toBe(200);
  bucket.objects.set(descriptor.artifact.locator, corrupt);
  const download = await handleGetWorkspaceArtifact(
    artifactRequest(workspaceId, issued.token, descriptor),
    db,
    bucket,
    workspaceId,
  );
  expect(download.status).toBe(400);
});

test("upload verifies zstd without Bun.zstdDecompressSync", async () => {
  const bun = globalThis.Bun as {
    zstdDecompressSync?: (value: Uint8Array) => Uint8Array;
  };
  const previous = bun.zstdDecompressSync;
  bun.zstdDecompressSync = undefined;
  try {
    const { db, sqlite } = await artifactDb();
    const { issued, workspaceId } = await pairedDevice(db, sqlite);
    const bucket = memoryArtifactBucket();
    const archive = await pack({ "SKILL.md": "# workerd\n" });
    const descriptor = transfer(workspaceId, skill, archive);
    const uploaded = await handlePutWorkspaceArtifact(
      artifactRequest(workspaceId, issued.token, descriptor, {
        method: "PUT",
        body: archive.bytes,
      }),
      db,
      bucket,
      workspaceId,
    );
    expect(uploaded.status).toBe(200);
    expect(bucket.objects.has(descriptor.artifact.locator)).toBe(true);
  } finally {
    bun.zstdDecompressSync = previous;
  }
});
