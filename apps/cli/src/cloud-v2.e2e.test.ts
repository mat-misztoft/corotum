import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitTreeHash, V2GitStateProvider } from "../../../packages/git-provider/src/index";
import {
  skillId,
  type DispositionLedger,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  postDeviceSyncReport,
  V2CloudNormalSync,
  V2SaaSProvider,
} from "../../../packages/saas-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import {
  handleGetWorkspaceArtifact,
  handlePostWorkspaceArtifactGc,
  handlePutWorkspaceArtifact,
} from "../../web/src/artifacts-http";
import { memoryArtifactBucket } from "../../web/src/artifacts";
import { approvePairing, createPairing } from "../../web/src/pairings";
import {
  handleGetWorkspaceState,
  handlePutWorkspaceState,
} from "../../web/src/state-http";
import { handlePostDeviceSyncReport } from "../../web/src/sync-report-http";
import { issueDeviceToken, type TokenDatabase } from "../../web/src/tokens";
import { SOURCE_REFRESH_NOTICE, type InitSkillOutcome } from "./init-adoption";
import { InitRecoveryStore, InitTransactionService } from "./init-transaction";
import { LocalOperationalStateStore } from "./local-state";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";
import { LifecycleRecoveryStore, V2LifecycleService } from "./v2-lifecycle";
import { V2LocalApplier } from "./v2-local-applier";
import { migrateV2CloudToGit, migrateV2GitToCloud } from "./v2-migration";
import { V2MutationService } from "./v2-mutations";
import { V2SyncService } from "./v2-sync";

const roots: string[] = [];
const migrationsDirectory = fileURLToPath(new URL("../../web/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const timeout = 60_000;
const emptyLedger: DispositionLedger = { version: 2, activeDispositions: {} };
const pairingDevice = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await Bun.spawn(["chmod", "-R", "u+rwx", root], { stderr: "pipe", stdout: "pipe" }).exited;
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-cloud-v2-e2e-${name}-`));
  roots.push(path);
  return path;
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

function platformEnv(home: string) {
  return {
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_RUNTIME_DIR: join(home, ".local", "runtime"),
    },
  };
}

function paths(home: string) {
  return resolvePlatformPaths(platformEnv(home));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(directory: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
}

async function enableCodex(home: string): Promise<void> {
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeJson(paths(home).configFile, {
    ...defaultConfig(),
    telemetry: false,
    agents: { codex: { enabled: true } },
  });
}

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
}

function targetSkill(home: string, name: string): string {
  return join(home, ".codex", "skills", name);
}

async function skillRepo(root: string, name: string, body: string) {
  const repository = join(root, `${name}.git`);
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", repository, "config", "user.name", "Corotum tests"]);
  await writeSkill(join(repository, "skills", name), body);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", name]);
  return {
    repository,
    revision: await git(["-C", repository, "rev-parse", "HEAD"]),
    contentHash: (await scanNormalizedContent(join(repository, "skills", name))).contentHash,
  };
}

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

async function pairDevice(
  db: TokenDatabase,
  sqlite: Database,
  user = { id: "user_1", email: "ada@example.com" },
  now = Date.now(),
) {
  sqlite
    .query(
      "INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(user.id, "Ada", user.email, Date.now(), Date.now());
  const pairing = await createPairing(db, pairingDevice, now);
  await approvePairing(db, user.id, pairing.id, pairing.userCode, now + 1);
  const issued = await issueDeviceToken(db, pairing.id, pairing.deviceCode, now + 2);
  return { issued, workspaceId: issued.workspaceId as string };
}

type TransportFault = Readonly<{
  outage?: boolean;
  missingArtifacts?: boolean;
  corruptArtifacts?: boolean;
}>;

function cloudFetch(
  db: TokenDatabase,
  bucket: ReturnType<typeof memoryArtifactBucket>,
  identity: string,
  fault: TransportFault = {},
): typeof fetch {
  return async (input, init) => {
    if (fault.outage) throw new TypeError("Cloud origin is unreachable.");
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", identity);
    const routed = new Request(request, { headers });
    const url = new URL(routed.url);
    const workspaceState = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/state$/);
    const workspaceGc = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/artifacts\/gc$/);
    const workspaceArtifact = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/artifacts$/);
    const syncReport = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/sync-report$/);
    if (workspaceState && routed.method === "GET") {
      return handleGetWorkspaceState(routed, db, decodeURIComponent(workspaceState[1]!));
    }
    if (workspaceState && routed.method === "PUT") {
      return handlePutWorkspaceState(routed, db, decodeURIComponent(workspaceState[1]!));
    }
    if (workspaceGc && routed.method === "POST") {
      return handlePostWorkspaceArtifactGc(routed, db, bucket, decodeURIComponent(workspaceGc[1]!));
    }
    if (workspaceArtifact && routed.method === "PUT") {
      return handlePutWorkspaceArtifact(routed, db, bucket, decodeURIComponent(workspaceArtifact[1]!));
    }
    if (workspaceArtifact && routed.method === "GET") {
      if (fault.missingArtifacts) return new Response(JSON.stringify({ error: "Artifact object is missing." }), { status: 404, headers: { "content-type": "application/json" } });
      if (fault.corruptArtifacts) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      return handleGetWorkspaceArtifact(routed, db, bucket, decodeURIComponent(workspaceArtifact[1]!));
    }
    if (syncReport && routed.method === "POST") {
      return handlePostDeviceSyncReport(routed, db, decodeURIComponent(syncReport[1]!));
    }
    return new Response(JSON.stringify({ error: `Unexpected URL ${url.pathname}` }), { status: 500, headers: { "content-type": "application/json" } });
  };
}

async function cloudWorkspace(label: string, user?: { id: string; email: string }) {
  const { sqlite, db } = await artifactDb();
  const first = await pairDevice(db, sqlite, user);
  const second = await pairDevice(db, sqlite, user ?? { id: "user_1", email: "ada@example.com" }, Date.now() + 10_000);
  const foreign = await pairDevice(db, sqlite, { id: "user_2", email: "bob@example.com" }, Date.now() + 20_000);
  const bucket = memoryArtifactBucket();
  const origin = "https://cloud.invalid";
  const fault: TransportFault = {};
  const fetchFor = (token: string, deviceId: string) =>
    cloudFetch(db, bucket, `${label}-${deviceId.slice(-8)}`, fault) as typeof fetch;
  const provider = (issued: { token: string; deviceId: string; workspaceId: string | null }) =>
    new V2SaaSProvider({
      origin,
      workspaceId: issued.workspaceId as string,
      deviceToken: issued.token,
      fetch: fetchFor(issued.token, issued.deviceId),
    });
  return {
    sqlite,
    db,
    bucket,
    origin,
    fault,
    workspaceId: first.workspaceId,
    machineA: { ...first.issued, workspaceId: first.workspaceId },
    machineB: { ...second.issued, workspaceId: second.workspaceId },
    foreign: { ...foreign.issued, workspaceId: foreign.workspaceId },
    fetchFor,
    provider,
  };
}

function mutationPort(cloud: V2SaaSProvider) {
  return {
    pull: async () => {
      const snapshot = await cloud.pull();
      return { revisionId: snapshot.revisionId ?? "", state: snapshot.state, ledger: snapshot.ledger };
    },
    push: async (input: {
      state: V2DesiredState;
      ledger: DispositionLedger;
      baseRevision: string;
      artifacts?: Readonly<Record<string, string>>;
    }) => {
      const artifacts: Record<string, Uint8Array> = {};
      for (const [id, directory] of Object.entries(input.artifacts ?? {})) {
        artifacts[id] = (await createArtifactArchive(directory)).bytes;
      }
      const snapshot = await cloud.push({
        state: input.state,
        ledger: input.ledger,
        baseRevision: input.baseRevision || null,
        artifacts,
      });
      if (!snapshot.revisionId) throw new Error("Cloud did not return a revision.");
      return { revisionId: snapshot.revisionId, state: snapshot.state, ledger: snapshot.ledger };
    },
  };
}

function initPort(cloud: V2SaaSProvider) {
  const port = mutationPort(cloud);
  return {
    pull: async () => {
      const snapshot = await cloud.pull();
      return { revisionId: snapshot.revisionId, state: snapshot.state, ledger: snapshot.ledger };
    },
    push: port.push,
  };
}

function homeServices(
  home: string,
  cloud: V2SaaSProvider,
  device: Readonly<{ token: string; deviceId: string }>,
  origin: string,
  fetch: typeof globalThis.fetch,
) {
  const current = paths(home);
  const stateStore = new LocalOperationalStateStore(join(current.stateDir, "state.json"));
  const canonicalStore = new CanonicalSkillStore(current.skillsDir);
  const applier = new V2LocalApplier(stateStore, canonicalStore, {
    storagePath: current.gitDir,
    repository: "cloud",
    enabledAgentIds: ["codex"],
    homeDir: home,
    artifactReader: async (locator) => {
      const snapshot = await cloud.pull();
      const lock = snapshot.state.lockfile.skills.find(
        (skill) =>
          skill.materialization.kind === "artifact" &&
          skill.materialization.artifact.locator === locator,
      );
      if (!lock) throw new Error("Artifact locator is not in desired state.");
      return cloud.downloadArtifact(lock);
    },
  });
  const envelope = async () => {
    const pulled = await cloud.pull();
    return { revisionId: pulled.revisionId ?? "", state: pulled.state, ledger: pulled.ledger };
  };
  const sync = new V2SyncService(
    { pull: envelope, pullReadOnly: envelope },
    applier,
    stateStore,
    {
      skillsStoragePath: current.skillsDir,
      homeDir: home,
      enabledAgentIds: ["codex"],
      reporter: async (input) => {
        const failed = input.operations.find((operation) => operation.status !== "SUCCESS");
        await postDeviceSyncReport({
          origin,
          deviceId: device.deviceId,
          deviceToken: device.token,
          fetch,
          report: {
            appliedRevisionId: input.state.lastAppliedRevision,
            syncStatus: input.kind === "synced" ? "SYNCED" : "ERROR",
            lastErrorCode: failed?.status ?? null,
            lastErrorMessage: failed?.error ?? null,
          },
        });
      },
    },
  );
  return {
    current,
    stateStore,
    applier,
    sync,
    lifecycle: new V2LifecycleService(
      mutationPort(cloud),
      applier,
      stateStore,
      new LifecycleRecoveryStore(join(current.stateDir, "lifecycle-transaction.json")),
    ),
    mutations: new V2MutationService(mutationPort(cloud), {
      resolve: async (source) => {
        const resolved = await new GitSkillMaterializer().resolve({
          id: skillId("sk_pendingadd"),
          source: source.repository,
          skill: source.path.split("/").at(-1) ?? "skill",
          ref: source.ref,
          path: source.path,
        });
        return { ...resolved, ref: source.ref, contentHash: resolved.contentHash as `sha256:${string}` };
      },
    }, applier),
  };
}

async function initializeCloudHome(
  home: string,
  cloud: V2SaaSProvider,
  workspaceId: string,
  outcomes: readonly InitSkillOutcome[],
) {
  await enableCodex(home);
  const current = paths(home);
  const stateStore = new LocalOperationalStateStore(join(current.stateDir, "state.json"));
  return new InitTransactionService({
    provider: initPort(cloud),
    recovery: new InitRecoveryStore(join(current.stateDir, "init-transaction.json")),
    persistConfig: async () => {
      await writeJson(current.configFile, {
        ...defaultConfig(),
        telemetry: false,
        mode: "cloud",
        workspaceId,
        deviceId: "dev_local",
        agents: { codex: { enabled: true } },
      });
    },
    backend: { kind: "cloud", workspaceId },
    stateStore,
    canonicalStore: new CanonicalSkillStore(current.skillsDir),
    enabledAgentIds: ["codex"],
    homeDir: home,
  }).run({ outcomes });
}

function sourceOutcome(
  name: string,
  path: string,
  source: Awaited<ReturnType<typeof skillRepo>>,
): InitSkillOutcome {
  return {
    kind: "source-backed",
    name,
    path,
    classification: "unchanged",
    source: {
      repository: source.repository,
      path: `skills/${name}`,
      ref: "main",
      revision: source.revision,
      contentHash: source.contentHash,
    },
    materialization: { kind: "source", contentHash: source.contentHash },
    notice: SOURCE_REFRESH_NOTICE,
  };
}

describe("Cloud v2 application/service end-to-end safety", () => {
  test(
    "fresh Cloud init and second-machine sync cover source and workspace-scoped R2 artifacts",
    async () => {
      const root = await temp("init");
      const cloud = await cloudWorkspace("init");
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await writeSkill(namedSkill(homeA, "public"), "# Public locked\n");
      await writeSkill(namedSkill(homeA, "custom"), "# Custom artifact\n");
      const scanned = await scanNormalizedContent(namedSkill(homeA, "custom"));
      const initialized = await initializeCloudHome(homeA, cloud.provider(cloud.machineA), cloud.workspaceId, [
        sourceOutcome("public", namedSkill(homeA, "public"), publicSkill),
        { kind: "artifact-backed", name: "custom", path: namedSkill(homeA, "custom"), classification: "unknown", localContentHash: scanned.contentHash },
      ]);
      expect(initialized.kind).toBe("initialized");
      const snapshot = await cloud.provider(cloud.machineA).pull();
      const sourceLock = snapshot.state.lockfile.skills.find((lock) => lock.name === "public");
      const artifactLock = snapshot.state.lockfile.skills.find((lock) => lock.name === "custom");
      expect(sourceLock?.materialization.kind).toBe("source");
      expect(artifactLock?.materialization).toMatchObject({ kind: "artifact", artifact: { kind: "r2-tar-zst" } });
      expect([...cloud.bucket.objects.keys()].every((key) => key.startsWith(`workspaces/${cloud.workspaceId}/`))).toBe(true);
      expect(cloud.bucket.objects.size).toBe(1);
      expect((await lstat(targetSkill(homeA, "public"))).isSymbolicLink()).toBe(true);

      await writeFile(join(publicSkill.repository, "skills", "public", "SKILL.md"), "# Public HEAD moved\n");
      await git(["-C", publicSkill.repository, "add", "."]);
      await git(["-C", publicSkill.repository, "commit", "-m", "move head"]);

      await enableCodex(homeB);
      const synced = await homeServices(
        homeB,
        cloud.provider(cloud.machineB),
        cloud.machineB,
        cloud.origin,
        cloud.fetchFor(cloud.machineB.token, cloud.machineB.deviceId),
      ).sync.sync();
      expect(synced.kind).toBe("synced");
      expect(await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8")).toBe("# Public locked\n");
      expect(await readFile(join(namedSkill(homeB, "custom"), "SKILL.md"), "utf8")).toBe("# Custom artifact\n");
      expect((await scanNormalizedContent(namedSkill(homeB, "public"))).contentHash).toBe(publicSkill.contentHash);
      expect((await lstat(targetSkill(homeB, "custom"))).isSymbolicLink()).toBe(true);
      expect(cloud.sqlite.query("SELECT sync_status AS status FROM device_workspaces WHERE device_id = ?").get(cloud.machineB.deviceId)).toEqual({ status: "SYNCED" });
    },
    timeout,
  );

  test(
    "artifact-backed private content installs without credentials while source AUTH_REQUIRED retains local files",
    async () => {
      const root = await temp("auth");
      const cloud = await cloudWorkspace("auth");
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const privateSkill = await skillRepo(root, "classified", "# Classified locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await writeSkill(namedSkill(homeA, "public"), "# Public locked\n");
      await writeSkill(namedSkill(homeA, "custom"), "# Custom artifact\n");
      const scanned = await scanNormalizedContent(namedSkill(homeA, "custom"));
      expect(
        (await initializeCloudHome(homeA, cloud.provider(cloud.machineA), cloud.workspaceId, [
          sourceOutcome("public", namedSkill(homeA, "public"), publicSkill),
          { kind: "artifact-backed", name: "custom", path: namedSkill(homeA, "custom"), classification: "unknown", localContentHash: scanned.contentHash },
        ])).kind,
      ).toBe("initialized");
      const added = await homeServices(
        homeA,
        cloud.provider(cloud.machineA),
        cloud.machineA,
        cloud.origin,
        cloud.fetchFor(cloud.machineA.token, cloud.machineA.deviceId),
      ).mutations.add({
        name: "classified",
        source: { repository: privateSkill.repository, path: "skills/classified", ref: "main" },
      });
      expect(added.kind === "success" || added.kind === "persisted-not-applied").toBe(true);

      await Bun.spawn(["chmod", "-R", "a-rwx", privateSkill.repository], { stderr: "pipe", stdout: "pipe" }).exited;
      await enableCodex(homeB);
      await writeSkill(namedSkill(homeB, "notes"), "# Unrelated unmanaged\n");
      await writeSkill(targetSkill(homeB, "notes"), "# Unrelated unmanaged\n");
      const synced = await homeServices(
        homeB,
        cloud.provider(cloud.machineB),
        cloud.machineB,
        cloud.origin,
        cloud.fetchFor(cloud.machineB.token, cloud.machineB.deviceId),
      ).sync.sync();
      expect(synced.kind).toBe("partial");
      expect(synced.operations.some((operation) => operation.status === "AUTH_REQUIRED")).toBe(true);
      expect(await readFile(join(namedSkill(homeB, "custom"), "SKILL.md"), "utf8")).toBe("# Custom artifact\n");
      expect(await readFile(join(namedSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe("# Unrelated unmanaged\n");
      expect(await readFile(join(targetSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe("# Unrelated unmanaged\n");
      await expect(readFile(join(namedSkill(homeB, "classified"), "SKILL.md"), "utf8")).rejects.toThrow();
    },
    timeout,
  );

  test(
    "offline REMOVE deletes verified copies, UNMANAGE preserves them, and re-add does not clobber modified unmanaged files",
    async () => {
      const root = await temp("ledger");
      const cloud = await cloudWorkspace("ledger");
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const extra = await skillRepo(root, "extra", "# Extra locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await writeSkill(namedSkill(homeA, "public"), "# Public locked\n");
      await writeSkill(namedSkill(homeA, "extra"), "# Extra locked\n");
      expect(
        (await initializeCloudHome(homeA, cloud.provider(cloud.machineA), cloud.workspaceId, [
          sourceOutcome("public", namedSkill(homeA, "public"), publicSkill),
          sourceOutcome("extra", namedSkill(homeA, "extra"), extra),
        ])).kind,
      ).toBe("initialized");
      await enableCodex(homeB);
      const servicesA = homeServices(homeA, cloud.provider(cloud.machineA), cloud.machineA, cloud.origin, cloud.fetchFor(cloud.machineA.token, cloud.machineA.deviceId));
      const servicesB = homeServices(homeB, cloud.provider(cloud.machineB), cloud.machineB, cloud.origin, cloud.fetchFor(cloud.machineB.token, cloud.machineB.deviceId));
      expect((await servicesB.sync.sync()).kind).toBe("synced");
      expect((await servicesA.lifecycle.remove("public")).kind).toBe("success");
      expect((await servicesA.lifecycle.unmanage("extra")).kind).toBe("success");
      expect((await servicesB.sync.sync()).kind).toBe("synced");
      await expect(lstat(namedSkill(homeB, "public"))).rejects.toThrow();
      await expect(lstat(targetSkill(homeB, "public"))).rejects.toThrow();
      expect(await readFile(join(namedSkill(homeB, "extra"), "SKILL.md"), "utf8")).toBe("# Extra locked\n");
      expect((await lstat(targetSkill(homeB, "extra"))).isSymbolicLink()).toBe(false);

      await writeFile(join(namedSkill(homeB, "extra"), "SKILL.md"), "# Modified unmanaged\n");
      await writeFile(join(targetSkill(homeB, "extra"), "SKILL.md"), "# Modified unmanaged\n");
      const readdedOnA = await servicesA.mutations.add({
        name: "extra",
        source: { repository: extra.repository, path: "skills/extra", ref: "main" },
      });
      expect(readdedOnA.kind === "success" || readdedOnA.kind === "persisted-not-applied").toBe(true);
      const readded = await servicesB.sync.sync();
      expect(readded.kind).toBe("partial");
      const conflicted =
        readded.operations.some((operation) => operation.status === "LOCAL_CONFLICT") ||
        readded.snapshot.plan.classifications.some((item) => item.classification === "LOCAL_CONFLICT");
      expect(conflicted).toBe(true);
      expect(await readFile(join(namedSkill(homeB, "extra"), "SKILL.md"), "utf8")).toBe("# Modified unmanaged\n");
      expect(await readFile(join(targetSkill(homeB, "extra"), "SKILL.md"), "utf8")).toBe("# Modified unmanaged\n");
    },
    timeout,
  );

  test(
    "outage, missing and corrupt artifacts, hash mismatch and report-after-verify leave last verified state intact",
    async () => {
      const root = await temp("faults");
      const cloud = await cloudWorkspace("faults");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await writeSkill(namedSkill(homeA, "custom"), "# Custom artifact\n");
      const scanned = await scanNormalizedContent(namedSkill(homeA, "custom"));
      expect(
        (await initializeCloudHome(homeA, cloud.provider(cloud.machineA), cloud.workspaceId, [
          { kind: "artifact-backed", name: "custom", path: namedSkill(homeA, "custom"), classification: "unknown", localContentHash: scanned.contentHash },
        ])).kind,
      ).toBe("initialized");
      await enableCodex(homeB);
      const providerB = cloud.provider(cloud.machineB);
      const fetchB = cloud.fetchFor(cloud.machineB.token, cloud.machineB.deviceId);
      const first = await homeServices(homeB, providerB, cloud.machineB, cloud.origin, fetchB).sync.sync();
      expect(first.kind).toBe("synced");
      const verified = JSON.parse(await readFile(join(paths(homeB).stateDir, "state.json"), "utf8")) as { lastAppliedRevision: string };
      expect(verified.lastAppliedRevision).toBeTruthy();

      cloud.fault.outage = true;
      const outage = await homeServices(homeB, providerB, cloud.machineB, cloud.origin, fetchB).sync.sync();
      expect(outage.kind).toBe("refused");
      expect(JSON.parse(await readFile(join(paths(homeB).stateDir, "state.json"), "utf8")).lastAppliedRevision).toBe(verified.lastAppliedRevision);
      cloud.fault.outage = false;

      cloud.fault.missingArtifacts = true;
      const missing = await new V2CloudNormalSync(providerB, {
        origin: cloud.origin,
        deviceId: cloud.machineB.deviceId,
        deviceToken: cloud.machineB.token,
        fetch: fetchB,
      }).sync({
        lastVerified: { appliedRevisionId: verified.lastAppliedRevision, canonical: {} },
        canonicalRoot: join(homeB, "canonical-missing"),
        targets: [{ skillId: skillId("sk_unusedmissing"), agentId: "codex", path: join(homeB, "missing-target") }],
      });
      expect(missing.report?.lastErrorCode === "ARTIFACT_UNAVAILABLE" || missing.skillResults.some((result) => result.code === "ARTIFACT_UNAVAILABLE")).toBe(true);
      expect(missing.lastVerified.appliedRevisionId).toBe(verified.lastAppliedRevision);
      cloud.fault.missingArtifacts = false;

      cloud.fault.corruptArtifacts = true;
      const corrupt = await new V2CloudNormalSync(providerB, {
        origin: cloud.origin,
        deviceId: cloud.machineB.deviceId,
        deviceToken: cloud.machineB.token,
        fetch: fetchB,
      }).sync({
        lastVerified: { appliedRevisionId: verified.lastAppliedRevision, canonical: {} },
        canonicalRoot: join(homeB, "canonical-corrupt"),
        targets: [{ skillId: skillId("sk_unusedcorrupt"), agentId: "codex", path: join(homeB, "corrupt-target") }],
      });
      expect(["ARTIFACT_UNAVAILABLE", "CONTENT_HASH_MISMATCH", "NETWORK_ERROR"]).toContain(corrupt.report?.lastErrorCode ?? corrupt.skillResults.find((result) => result.code)?.code);
      expect(corrupt.lastVerified.appliedRevisionId).toBe(verified.lastAppliedRevision);
      cloud.fault.corruptArtifacts = false;

      const locator = [...cloud.bucket.objects.keys()][0]!;
      const original = cloud.bucket.objects.get(locator)!;
      const mutated = original.slice();
      mutated[mutated.length - 1] = (mutated[mutated.length - 1]! + 1) & 0xff;
      cloud.bucket.objects.set(locator, mutated);
      const mismatch = await new V2CloudNormalSync(providerB, {
        origin: cloud.origin,
        deviceId: cloud.machineB.deviceId,
        deviceToken: cloud.machineB.token,
        fetch: fetchB,
      }).sync({
        lastVerified: { appliedRevisionId: verified.lastAppliedRevision, canonical: {} },
        canonicalRoot: join(homeB, "canonical-hash"),
        targets: [{ skillId: skillId("sk_unusedhash"), agentId: "codex", path: join(homeB, "hash-target") }],
      });
      expect(["CONTENT_HASH_MISMATCH", "ARTIFACT_UNAVAILABLE"]).toContain(mismatch.report?.lastErrorCode ?? mismatch.skillResults.find((result) => result.code)?.code);
      expect(mismatch.lastVerified.appliedRevisionId).toBe(verified.lastAppliedRevision);
      cloud.bucket.objects.set(locator, original);

      const lock = (await providerB.pull()).state.lockfile.skills[0]!;
      const reportCanonical = join(homeB, "canonical-report");
      const reportTarget = join(homeB, "agent-report", "custom");
      await mkdir(join(homeB, "agent-report"), { recursive: true });
      await mkdir(reportCanonical, { recursive: true });
      await symlink(join(reportCanonical, "custom"), reportTarget);
      const reported = await new V2CloudNormalSync(providerB, {
        origin: cloud.origin,
        deviceId: cloud.machineB.deviceId,
        deviceToken: cloud.machineB.token,
        fetch: fetchB,
      }).sync({
        lastVerified: { appliedRevisionId: null, canonical: {} },
        canonicalRoot: reportCanonical,
        targets: [{ skillId: lock.id, agentId: "codex", path: reportTarget }],
      });
      expect(reported.report).toMatchObject({ syncStatus: "SYNCED" });
      expect(reported.receipt).toMatchObject({ syncStatus: "SYNCED", appliedRevisionId: reported.report?.appliedRevisionId });
      expect(reported.lastVerified.appliedRevisionId).toBe((await providerB.pull()).revisionId);
      expect(await readFile(join(namedSkill(homeB, "custom"), "SKILL.md"), "utf8")).toBe("# Custom artifact\n");
    },
    timeout,
  );

  test(
    "missing state recovers, partial local failure preserves unmanaged files, and Git↔Cloud round-trips artifacts only",
    async () => {
      const root = await temp("recover");
      const cloud = await cloudWorkspace("recover");
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await writeSkill(namedSkill(homeA, "public"), "# Public locked\n");
      expect(
        (await initializeCloudHome(homeA, cloud.provider(cloud.machineA), cloud.workspaceId, [
          sourceOutcome("public", namedSkill(homeA, "public"), publicSkill),
        ])).kind,
      ).toBe("initialized");
      await enableCodex(homeB);
      const servicesB = homeServices(homeB, cloud.provider(cloud.machineB), cloud.machineB, cloud.origin, cloud.fetchFor(cloud.machineB.token, cloud.machineB.deviceId));
      expect((await servicesB.sync.sync()).kind).toBe("synced");
      await rm(join(paths(homeB).stateDir, "state.json"), { force: true });
      const recovered = await servicesB.sync.inspect();
      expect(recovered.kind).toBe("ready");
      expect((await servicesB.sync.sync()).kind).toBe("synced");
      expect(await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8")).toBe("# Public locked\n");

      await writeSkill(namedSkill(homeB, "notes"), "# Local notes\n");
      await writeSkill(targetSkill(homeB, "notes"), "# Local notes\n");
      const notesDir = join(root, "notes-src");
      await writeSkill(notesDir, "# Cloud notes\n");
      const notesHash = (await scanNormalizedContent(notesDir)).contentHash;
      const notesId = skillId("sk_notespartial");
      const current = await cloud.provider(cloud.machineA).pull();
      const archive = await createArtifactArchive(notesDir);
      const locator = `workspaces/${cloud.workspaceId}/artifacts/${notesId}/${archive.integrityHash}.tar.zst`;
      const next: V2DesiredState = {
        manifest: {
          version: 2,
          skills: [
            ...current.state.manifest.skills,
            { id: notesId, name: "notes", targets: "all", resolutionStatus: "RESOLVED" },
          ],
        },
        lockfile: {
          version: 2,
          skills: [
            ...current.state.lockfile.skills,
            {
              id: notesId,
              name: "notes",
              materialization: {
                kind: "artifact",
                artifact: { kind: "r2-tar-zst", contentHash: notesHash, integrityHash: archive.integrityHash, locator, sizeBytes: archive.sizeBytes },
              },
            },
          ],
        },
      };
      await cloud.provider(cloud.machineA).push({
        state: next,
        ledger: current.ledger,
        baseRevision: current.revisionId,
        artifacts: { [notesId]: archive.bytes },
      });
      const partial = await servicesB.sync.sync();
      expect(partial.kind).toBe("partial");
      expect(await readFile(join(namedSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe("# Local notes\n");
      expect(await readFile(join(targetSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe("# Local notes\n");

      const gitRoot = join(root, "git-round");
      const gitProvider = await (async () => {
        const remote = join(gitRoot, "remote.git");
        const worktree = join(gitRoot, "worktree");
        await git(["init", "--initial-branch=main", worktree]);
        await git(["-C", worktree, "config", "user.email", "tests@corotum.invalid"]);
        await git(["-C", worktree, "config", "user.name", "Corotum tests"]);
        await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
        await git(["init", "--bare", remote]);
        await git(["-C", worktree, "remote", "add", "origin", remote]);
        await git(["-C", worktree, "push", "-u", "origin", "main"]);
        await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
        const provider = new V2GitStateProvider(join(gitRoot, "cache"), remote, undefined, async () => undefined);
        await provider.push({
          state: { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } },
          ledger: emptyLedger,
          baseRevision: await git(["-C", worktree, "rev-parse", "HEAD"]),
        });
        return provider;
      })();
      const artifactDirectory = join(gitRoot, "artifact");
      await writeSkill(artifactDirectory, "# git artifact\n");
      const contentHash = (await scanNormalizedContent(artifactDirectory)).contentHash;
      const integrityHash = await gitTreeHash(artifactDirectory);
      const artifactId = skillId("sk_gitround");
      const sourceId = skillId("sk_srcround");
      const sourceMeta = { repository: publicSkill.repository, path: "skills/public", ref: "main" };
      const gitState: V2DesiredState = {
        manifest: { version: 2, skills: [
          { id: artifactId, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" },
          { id: sourceId, name: "upstream", targets: "all", source: sourceMeta, resolutionStatus: "RESOLVED" },
        ] },
        lockfile: { version: 2, skills: [
          { id: artifactId, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: `artifacts/${artifactId}/${integrityHash.slice(7)}`, contentHash, integrityHash, sizeBytes: 1 } } },
          { id: sourceId, name: "upstream", source: { ...sourceMeta, revision: publicSkill.revision, contentHash: publicSkill.contentHash }, materialization: { kind: "source", contentHash: publicSkill.contentHash } },
        ] },
      };
      const seeded = await gitProvider.push({
        state: gitState,
        ledger: emptyLedger,
        baseRevision: (await gitProvider.pull()).revisionId,
        artifacts: { [artifactId]: artifactDirectory },
      });
      const roundCloud = await cloudWorkspace("roundtrip", { id: "user_3", email: "cara@example.com" });
      const destination = roundCloud.provider(roundCloud.machineA);
      const migrated = await migrateV2GitToCloud({
        source: seeded,
        artifacts: gitProvider,
        destination: {
          pull: async () => {
            const snapshot = await destination.pull();
            return { revisionId: snapshot.revisionId, state: snapshot.state, ledger: snapshot.ledger };
          },
          push: async (input) => {
            const pushed = await destination.push(input);
            return { revisionId: pushed.revisionId };
          },
        },
        workspaceId: roundCloud.workspaceId,
      });
      expect(migrated).toBeTruthy();
      const cloudSnapshot = await destination.pull();
      expect(cloudSnapshot.state.lockfile.skills.find((lock) => lock.id === sourceId)?.materialization.kind).toBe("source");
      expect(cloudSnapshot.state.lockfile.skills.find((lock) => lock.id === artifactId)?.materialization).toMatchObject({
        kind: "artifact",
        artifact: { kind: "r2-tar-zst", contentHash },
      });
      expect(roundCloud.bucket.objects.size).toBe(1);
      const back = await migrateV2CloudToGit({
        source: { state: cloudSnapshot.state, ledger: cloudSnapshot.ledger },
        artifacts: destination,
        destination: gitProvider,
      });
      expect(back).toBeTruthy();
      const gitAfter = await gitProvider.pull();
      expect(gitAfter.state.lockfile.skills.find((lock) => lock.id === artifactId)?.materialization).toMatchObject({
        kind: "artifact",
        artifact: { kind: "git-tree", contentHash },
      });
      expect(gitAfter.state.lockfile.skills.find((lock) => lock.id === sourceId)?.source?.revision).toBe(publicSkill.revision);
    },
    timeout,
  );

  test(
    "GC retains current plus previous artifacts and cross-workspace tokens cannot read another workspace object",
    async () => {
      const root = await temp("gc");
      const cloud = await cloudWorkspace("gc");
      const home = join(root, "home-a");
      await writeSkill(namedSkill(home, "custom"), "# one\n");
      const firstHash = (await scanNormalizedContent(namedSkill(home, "custom"))).contentHash;
      expect(
        (await initializeCloudHome(home, cloud.provider(cloud.machineA), cloud.workspaceId, [
          { kind: "artifact-backed", name: "custom", path: namedSkill(home, "custom"), classification: "unknown", localContentHash: firstHash },
        ])).kind,
      ).toBe("initialized");
      const firstLocator = [...cloud.bucket.objects.keys()][0]!;

      await writeFile(join(namedSkill(home, "custom"), "SKILL.md"), "# two\n");
      const secondArchive = await createArtifactArchive(namedSkill(home, "custom"));
      const current = await cloud.provider(cloud.machineA).pull();
      const lock = current.state.lockfile.skills[0]!;
      const secondLocator = `workspaces/${cloud.workspaceId}/artifacts/${lock.id}/${secondArchive.integrityHash}.tar.zst`;
      const secondState: V2DesiredState = {
        manifest: current.state.manifest,
        lockfile: {
          version: 2,
          skills: [{
            ...lock,
            materialization: {
              kind: "artifact",
              artifact: {
                kind: "r2-tar-zst",
                contentHash: secondArchive.contentHash,
                integrityHash: secondArchive.integrityHash,
                locator: secondLocator,
                sizeBytes: secondArchive.sizeBytes,
              },
            },
          }],
        },
      };
      await cloud.provider(cloud.machineA).push({
        state: secondState,
        ledger: current.ledger,
        baseRevision: current.revisionId,
        artifacts: { [lock.id]: secondArchive.bytes },
      });

      await writeFile(join(namedSkill(home, "custom"), "SKILL.md"), "# three\n");
      const thirdArchive = await createArtifactArchive(namedSkill(home, "custom"));
      const afterSecond = await cloud.provider(cloud.machineA).pull();
      const thirdLocator = `workspaces/${cloud.workspaceId}/artifacts/${lock.id}/${thirdArchive.integrityHash}.tar.zst`;
      await cloud.provider(cloud.machineA).push({
        state: {
          manifest: afterSecond.state.manifest,
          lockfile: {
            version: 2,
            skills: [{
              ...lock,
              materialization: {
                kind: "artifact",
                artifact: {
                  kind: "r2-tar-zst",
                  contentHash: thirdArchive.contentHash,
                  integrityHash: thirdArchive.integrityHash,
                  locator: thirdLocator,
                  sizeBytes: thirdArchive.sizeBytes,
                },
              },
            }],
          },
        },
        ledger: afterSecond.ledger,
        baseRevision: afterSecond.revisionId,
        artifacts: { [lock.id]: thirdArchive.bytes },
      });

      const collected = await handlePostWorkspaceArtifactGc(
        new Request(`https://cloud.invalid/api/v1/workspaces/${cloud.workspaceId}/artifacts/gc`, {
          method: "POST",
          headers: {
            [DEVICE_TOKEN_HEADER]: cloud.machineA.token,
            [CLI_VERSION_HEADER]: "0.1.0",
            "x-forwarded-for": "gc-owner",
          },
        }),
        cloud.db,
        cloud.bucket,
        cloud.workspaceId,
      );
      expect(collected.status).toBe(200);
      expect(cloud.bucket.objects.has(firstLocator)).toBe(false);
      expect(cloud.bucket.objects.has(secondLocator)).toBe(true);
      expect(cloud.bucket.objects.has(thirdLocator)).toBe(true);

      const stolen = cloud.provider({
        token: cloud.foreign.token,
        deviceId: cloud.foreign.deviceId,
        workspaceId: cloud.workspaceId,
      });
      const latest = (await cloud.provider(cloud.machineA).pull()).state.lockfile.skills[0]!;
      await expect(stolen.downloadArtifact(latest)).rejects.toThrow();
      expect(cloud.bucket.objects.has(thirdLocator)).toBe(true);
    },
    timeout,
  );
});
