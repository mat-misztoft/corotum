import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DispositionLedger,
  skillId,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import { V2GitStateProvider } from "../../../packages/git-provider/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { LocalOperationalStateStore } from "./local-state";
import { V2LocalApplier } from "./v2-local-applier";
import {
  type V2SyncEnvelope,
  type V2SyncProviderPort,
  V2SyncService,
  v2SyncStatusPayload,
} from "./v2-sync";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function git(args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-v2-sync-${name}-`));
  directories.push(path);
  return path;
}

const emptyLedger: DispositionLedger = { version: 2, activeDispositions: {} };

async function skillSource(root: string, body = "# Exact\n") {
  const repository = join(root, "source.git");
  await git(["init", "--initial-branch=main", repository]);
  await git([
    "-C",
    repository,
    "config",
    "user.email",
    "tests@corotum.invalid",
  ]);
  await git(["-C", repository, "config", "user.name", "Corotum tests"]);
  await mkdir(join(repository, "demo"));
  await writeFile(join(repository, "demo", "SKILL.md"), body);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", "skill"]);
  const revision = await git(["-C", repository, "rev-parse", "HEAD"]);
  const contentHash = (await scanNormalizedContent(join(repository, "demo")))
    .contentHash;
  return { repository, revision, contentHash };
}

async function gitStateRemote(root: string) {
  const worktree = join(root, "state-worktree");
  const bare = join(root, "state.git");
  await git(["init", "--initial-branch=main", worktree]);
  await git(["-C", worktree, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", worktree, "config", "user.name", "Corotum tests"]);
  await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", bare]);
  await git(["-C", worktree, "remote", "add", "origin", bare]);
  await git(["-C", worktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return bare;
}

function desiredFor(
  source: Awaited<ReturnType<typeof skillSource>>,
  targets: V2DesiredState["manifest"]["skills"][number]["targets"] = ["pi"],
): V2DesiredState {
  const id = skillId("sk_demo");
  return {
    manifest: {
      version: 2,
      skills: [
        {
          id,
          name: "demo",
          targets,
          source: { repository: source.repository, path: "demo", ref: "main" },
          resolutionStatus: "RESOLVED",
        },
      ],
    },
    lockfile: {
      version: 2,
      skills: [
        {
          id,
          name: "demo",
          source: {
            repository: source.repository,
            path: "demo",
            ref: "main",
            revision: source.revision,
            contentHash: source.contentHash,
          },
          materialization: { kind: "source", contentHash: source.contentHash },
        },
      ],
    },
  };
}

function gitPort(provider: V2GitStateProvider): V2SyncProviderPort {
  return {
    pull: () => provider.pull(),
    pullReadOnly: () => provider.pullReadOnly(),
    peekPendingPush: () => provider.peekPendingPush(),
  };
}

function memoryCloud(
  initial: V2SyncEnvelope,
): V2SyncProviderPort & { envelope: V2SyncEnvelope; failPull?: Error } {
  const port = {
    envelope: initial,
    failPull: undefined as Error | undefined,
    pull: async () => {
      if (port.failPull) throw port.failPull;
      return port.envelope;
    },
    pullReadOnly: async () => port.envelope,
  };
  return port;
}

async function homeRuntime(
  root: string,
  port: V2SyncProviderPort,
  reporter?: ConstructorParameters<typeof V2SyncService>[3]["reporter"],
) {
  const homeDir = join(root, "home");
  const skillsStoragePath = join(homeDir, "canonical");
  const stateStore = new LocalOperationalStateStore(
    join(homeDir, "state.json"),
  );
  const applier = new V2LocalApplier(
    stateStore,
    new CanonicalSkillStore(skillsStoragePath),
    {
      storagePath: join(root, "git-cache"),
      repository: "https://example.test/state.git",
      enabledAgentIds: ["pi"],
      homeDir,
    },
  );
  const service = new V2SyncService(port, applier, stateStore, {
    skillsStoragePath,
    homeDir,
    enabledAgentIds: ["pi"],
    reporter,
  });
  return { homeDir, skillsStoragePath, stateStore, service, applier };
}

describe("v2 CLI sync/reconcile integration", () => {
  test("git sync materializes the exact lock, verifies symlink targets, and advances revision", async () => {
    const root = await temp("git-install");
    const source = await skillSource(root);
    const bare = await gitStateRemote(root);
    const gitProvider = new V2GitStateProvider(
      join(root, "git-cache"),
      bare,
      undefined,
      async () => undefined,
    );
    const empty = await gitProvider.pullAllowEmpty();
    const published = await gitProvider.push({
      state: desiredFor(source),
      ledger: emptyLedger,
      baseRevision: empty.revisionId,
    });
    const { homeDir, service, stateStore } = await homeRuntime(
      root,
      gitPort(gitProvider),
    );
    await mkdir(join(homeDir, ".pi", "agent", "skills"), { recursive: true });

    const result = await service.sync();
    expect(result.kind).toBe("synced");
    expect(
      await readFile(join(homeDir, "canonical", "demo", "SKILL.md"), "utf8"),
    ).toBe("# Exact\n");
    expect(
      (
        await lstat(join(homeDir, ".pi", "agent", "skills", "demo"))
      ).isSymbolicLink(),
    ).toBe(true);
    expect((await stateStore.load())?.lastAppliedRevision).toBe(
      published.revisionId,
    );
    const status = await service.inspect();
    expect(status.kind).toBe("ready");
    if (status.kind === "ready") {
      expect(status.snapshot.plan.classifications).toEqual([
        { skillId: skillId("sk_demo"), classification: "MANAGED_SYNCED" },
      ]);
      expect(v2SyncStatusPayload(status)).toMatchObject({
        outcome: "SUCCESS",
        status: "READY",
        revision: published.revisionId,
        pendingPush: false,
      });
    }
  });

  test("recovers missing and corrupt operational state from named canonical plus symlink", async () => {
    const root = await temp("recover");
    const source = await skillSource(root);
    const bare = await gitStateRemote(root);
    const gitProvider = new V2GitStateProvider(
      join(root, "git-cache"),
      bare,
      undefined,
      async () => undefined,
    );
    const empty = await gitProvider.pullAllowEmpty();
    await gitProvider.push({
      state: desiredFor(source),
      ledger: emptyLedger,
      baseRevision: empty.revisionId,
    });
    const { homeDir, service, stateStore, skillsStoragePath } =
      await homeRuntime(root, gitPort(gitProvider));
    await mkdir(join(homeDir, ".pi", "agent", "skills"), { recursive: true });
    expect((await service.sync()).kind).toBe("synced");

    await rm(join(homeDir, "state.json"), { force: true });
    const recovered = await service.inspect();
    expect(recovered.kind).toBe("ready");
    if (recovered.kind === "ready") {
      expect(recovered.state.skills[skillId("sk_demo")]?.ownership).toBe(
        "recovered",
      );
      expect(recovered.snapshot.plan.classifications[0]?.classification).toBe(
        "MANAGED_SYNCED",
      );
    }

    await writeFile(join(homeDir, "state.json"), "{not-json");
    const afterCorrupt = await service.inspect();
    expect(afterCorrupt.kind).toBe("ready");
    expect(
      (await scanNormalizedContent(join(skillsStoragePath, "demo")))
        .contentHash,
    ).toBe(source.contentHash);
  });

  test("does not overwrite copy or symlink drift and leaves unmanaged collisions untouched", async () => {
    const root = await temp("drift");
    const source = await skillSource(root);
    const bare = await gitStateRemote(root);
    const gitProvider = new V2GitStateProvider(
      join(root, "git-cache"),
      bare,
      undefined,
      async () => undefined,
    );
    const empty = await gitProvider.pullAllowEmpty();
    await gitProvider.push({
      state: desiredFor(source),
      ledger: emptyLedger,
      baseRevision: empty.revisionId,
    });
    const { homeDir, service } = await homeRuntime(root, gitPort(gitProvider));
    await mkdir(join(homeDir, ".pi", "agent", "skills"), { recursive: true });
    expect((await service.sync()).kind).toBe("synced");

    await writeFile(
      join(homeDir, "canonical", "demo", "SKILL.md"),
      "# Drifted canonical\n",
    );
    const drifted = await service.sync();
    expect(drifted.kind).toBe("partial");
    expect(
      await readFile(join(homeDir, "canonical", "demo", "SKILL.md"), "utf8"),
    ).toBe("# Drifted canonical\n");
    if (drifted.kind === "partial") {
      expect(drifted.kind).toBe("partial");
      expect(v2SyncStatusPayload(drifted).status).toBe("DRIFTED");
    }

    const collisionRoot = await temp("collision");
    const collisionSource = await skillSource(collisionRoot);
    const collisionBare = await gitStateRemote(collisionRoot);
    const collisionGit = new V2GitStateProvider(
      join(collisionRoot, "git-cache"),
      collisionBare,
      undefined,
      async () => undefined,
    );
    const collisionEmpty = await collisionGit.pullAllowEmpty();
    await collisionGit.push({
      state: desiredFor(collisionSource),
      ledger: emptyLedger,
      baseRevision: collisionEmpty.revisionId,
    });
    const collision = await homeRuntime(collisionRoot, gitPort(collisionGit));
    await mkdir(join(collision.homeDir, "canonical", "demo"), {
      recursive: true,
    });
    await writeFile(
      join(collision.homeDir, "canonical", "demo", "SKILL.md"),
      "# Local only\n",
    );
    const blocked = await collision.service.sync();
    expect(blocked.kind).toBe("partial");
    expect(
      await readFile(
        join(collision.homeDir, "canonical", "demo", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# Local only\n");
    if (blocked.kind === "partial") {
      expect(v2SyncStatusPayload(blocked).status).toBe("LOCAL_CONFLICT");
    }
  });

  test("offline REMOVE and UNMANAGE use the durable ledger and never delete unverified copies", async () => {
    const root = await temp("ledger");
    const source = await skillSource(root);
    const bare = await gitStateRemote(root);
    const gitProvider = new V2GitStateProvider(
      join(root, "git-cache"),
      bare,
      undefined,
      async () => undefined,
    );
    const empty = await gitProvider.pullAllowEmpty();
    const installed = await gitProvider.push({
      state: desiredFor(source),
      ledger: emptyLedger,
      baseRevision: empty.revisionId,
    });
    const { homeDir, service, stateStore } = await homeRuntime(
      root,
      gitPort(gitProvider),
    );
    await mkdir(join(homeDir, ".pi", "agent", "skills"), { recursive: true });
    expect((await service.sync()).kind).toBe("synced");

    const removedState: V2DesiredState = {
      manifest: { version: 2, skills: [] },
      lockfile: { version: 2, skills: [] },
    };
    await gitProvider.push({
      state: removedState,
      ledger: {
        version: 2,
        activeDispositions: {
          [skillId("sk_demo")]: {
            skillId: skillId("sk_demo"),
            name: "demo",
            disposition: "UNMANAGE",
            effectiveSequence: 2,
          },
        },
      },
      baseRevision: installed.revisionId,
    });
    const unmanaged = await service.sync();
    expect(unmanaged.kind).toBe("synced");
    expect(
      await readFile(join(homeDir, "canonical", "demo", "SKILL.md"), "utf8"),
    ).toBe("# Exact\n");
    expect(
      (await stateStore.load())?.skills[skillId("sk_demo")],
    ).toBeUndefined();

    const removeRoot = await temp("remove");
    const removeSource = await skillSource(removeRoot);
    const removeBare = await gitStateRemote(removeRoot);
    const removeGit = new V2GitStateProvider(
      join(removeRoot, "git-cache"),
      removeBare,
      undefined,
      async () => undefined,
    );
    const removeEmpty = await removeGit.pullAllowEmpty();
    const removeInstalled = await removeGit.push({
      state: desiredFor(removeSource),
      ledger: emptyLedger,
      baseRevision: removeEmpty.revisionId,
    });
    const removeHome = await homeRuntime(removeRoot, gitPort(removeGit));
    await mkdir(join(removeHome.homeDir, ".pi", "agent", "skills"), {
      recursive: true,
    });
    expect((await removeHome.service.sync()).kind).toBe("synced");
    await removeGit.push({
      state: removedState,
      ledger: {
        version: 2,
        activeDispositions: {
          [skillId("sk_demo")]: {
            skillId: skillId("sk_demo"),
            name: "demo",
            disposition: "REMOVE",
            effectiveSequence: 2,
          },
        },
      },
      baseRevision: removeInstalled.revisionId,
    });
    expect((await removeHome.service.sync()).kind).toBe("synced");
    await expect(
      readFile(
        join(removeHome.homeDir, "canonical", "demo", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  test("git pending push stays explicitly recoverable on status and sync", async () => {
    const pending = new Error(
      "A previous v2 desired-state change is waiting to be pushed.",
    );
    const port: V2SyncProviderPort = {
      peekPendingPush: async () => true,
      pull: async () => {
        throw pending;
      },
      pullReadOnly: async () => ({
        revisionId: "rev-local",
        state: {
          manifest: { version: 2, skills: [] },
          lockfile: { version: 2, skills: [] },
        },
        ledger: emptyLedger,
      }),
    };
    const { service } = await homeRuntime(await temp("pending"), port);
    const status = await service.inspect();
    expect(status.kind).toBe("ready");
    if (status.kind === "ready") expect(status.pendingPush).toBe(true);
    const sync = await service.sync();
    expect(sync.kind).toBe("pending-push");
    expect(v2SyncStatusPayload(sync)).toMatchObject({
      outcome: "CONFLICT",
      status: "PENDING_PUSH",
    });
  });

  test("cloud fixture selects cloud state, reports after persist, and keeps remote/local failures recoverable", async () => {
    const root = await temp("cloud");
    const source = await skillSource(root);
    const envelope: V2SyncEnvelope = {
      revisionId: "cloud-rev-1",
      state: desiredFor(source),
      ledger: emptyLedger,
    };
    const cloud = memoryCloud(envelope);
    const reports: unknown[] = [];
    const { homeDir, service, stateStore } = await homeRuntime(
      root,
      cloud,
      async (input) => {
        reports.push({
          applied: input.state.lastAppliedRevision,
          kind: input.kind,
        });
      },
    );
    await mkdir(join(homeDir, ".pi", "agent", "skills"), { recursive: true });
    const first = await service.sync();
    expect(first.kind).toBe("synced");
    expect(reports).toEqual([{ applied: "cloud-rev-1", kind: "synced" }]);
    expect((await stateStore.load())?.lastAppliedRevision).toBe("cloud-rev-1");

    reports.length = 0;
    await writeFile(
      join(homeDir, "canonical", "demo", "SKILL.md"),
      "# Local edit\n",
    );
    const failedLocal = memoryCloud({
      revisionId: "cloud-rev-2",
      state: desiredFor(source),
      ledger: emptyLedger,
    });
    const retryHome = await homeRuntime(root, failedLocal, async (input) => {
      reports.push({
        applied: input.state.lastAppliedRevision,
        kind: input.kind,
      });
    });
    const retry = retryHome.service;
    const partial = await retry.sync();
    expect(partial.kind).toBe("partial");
    expect(
      await readFile(join(homeDir, "canonical", "demo", "SKILL.md"), "utf8"),
    ).toBe("# Local edit\n");
    if (partial.kind === "partial") {
      expect(partial.state.lastAppliedRevision).toBe("cloud-rev-1");
      expect(reports[0]).toEqual({ applied: "cloud-rev-1", kind: "partial" });
    }

    const inspect = await retry.inspect();
    expect(inspect.kind).toBe("ready");
    if (inspect.kind === "ready") {
      expect(
        inspect.snapshot.plan.classifications.some(
          (item) => item.classification === "DRIFTED",
        ),
      ).toBe(true);
    }
  });

  test("partial target failure does not advance the applied revision and does not claim synced", async () => {
    const root = await temp("partial");
    const source = await skillSource(root);
    const collision = join(root, "home", ".pi", "agent", "skills", "demo");
    await mkdir(join(root, "home", ".pi", "agent", "skills"), {
      recursive: true,
    });
    await mkdir(collision);
    await writeFile(join(collision, "SKILL.md"), "# Unmanaged target\n");
    const cloud = memoryCloud({
      revisionId: "rev-target",
      state: desiredFor(source),
      ledger: emptyLedger,
    });
    const { service, stateStore, homeDir } = await homeRuntime(root, cloud);
    const result = await service.sync();
    expect(result.kind).toBe("partial");
    expect((await stateStore.load())?.lastAppliedRevision).toBeNull();
    expect(await readFile(join(collision, "SKILL.md"), "utf8")).toBe(
      "# Unmanaged target\n",
    );
    await expect(
      readFile(join(homeDir, "canonical", "demo", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    expect(v2SyncStatusPayload(result).outcome).toBe("CONFLICT");
  });

  test("typed JSON outcomes include schema-versioned classifications for inspect", async () => {
    const port = memoryCloud({
      revisionId: "rev",
      state: {
        manifest: { version: 2, skills: [] },
        lockfile: { version: 2, skills: [] },
      },
      ledger: emptyLedger,
    });
    const { service } = await homeRuntime(await temp("json"), port);
    const inspect = await service.inspect();
    const payload = v2SyncStatusPayload(inspect);
    expect(payload).toMatchObject({
      outcome: "SUCCESS",
      revision: "rev",
      classifications: [],
      operations: [],
    });
  });
});
