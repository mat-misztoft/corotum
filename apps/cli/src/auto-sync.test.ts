import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutoStatus,
  AutoStatusStore,
  AutoSyncScheduler,
  autoRetryDelay,
  revisionFromMetadata,
  runAutoSyncAwareCommand,
} from "./auto-sync";
import type { V2SyncResult } from "./v2-sync";

test("new login/pair credentials restart an exited worker after the command drains", async () => {
  for (const previous of [undefined, "old-token"]) {
    let token = previous;
    const events: string[] = [];
    expect(
      await runAutoSyncAwareCommand({
        pendingUpdateApplied: false,
        loadToken: async () => token,
        restart: async () => {
          events.push("restart");
        },
        run: async () => {
          token = "new-token";
          events.push("drained");
          return 0;
        },
      }),
    ).toBe(0);
    expect(events).toEqual(["drained", "restart"]);
  }
});

test("pairing resumes auto even if later initialization fails", async () => {
  let token: string | undefined;
  let restarts = 0;
  await expect(
    runAutoSyncAwareCommand({
      pendingUpdateApplied: false,
      loadToken: async () => token,
      restart: async () => {
        restarts++;
      },
      run: async () => {
        token = "paired";
        throw new Error("init failed");
      },
    }),
  ).rejects.toThrow("init failed");
  expect(restarts).toBe(1);
});

test("unchanged credentials and logout do not restart auto", async () => {
  for (const next of ["existing", undefined]) {
    let token: string | undefined = "existing";
    await runAutoSyncAwareCommand({
      pendingUpdateApplied: false,
      loadToken: async () => token,
      restart: async () => {
        throw new Error("unexpected restart");
      },
      run: async () => {
        token = next;
      },
    });
  }
});

test("actually applied pending update restarts the new worker before running the command", async () => {
  const events: string[] = [];
  await runAutoSyncAwareCommand({
    pendingUpdateApplied: true,
    loadToken: async () => "existing",
    restart: async () => {
      events.push("restart updated executable");
    },
    run: async () => {
      events.push("command");
    },
  });
  expect(events).toEqual(["restart updated executable", "command"]);
});

test("scheduled worker hands an applied update to the new executable without stopping its own task", async () => {
  const result = await runAutoSyncAwareCommand({
    pendingUpdateApplied: true,
    loadToken: async () => {
      throw new Error("old worker must not initialize");
    },
    restart: async () => {
      throw new Error("must not stop our own task");
    },
    run: async () => {
      throw new Error("must not run old worker");
    },
    runUpdatedWorker: async () => 7,
  });
  expect(result).toBe(7);
});

test("worker with no applied update runs normally without a handoff", async () => {
  expect(
    await runAutoSyncAwareCommand({
      pendingUpdateApplied: false,
      loadToken: async () => "existing",
      restart: async () => {
        throw new Error("unexpected restart");
      },
      run: async () => 0,
      runUpdatedWorker: async () => {
        throw new Error("update not applied");
      },
    }),
  ).toBe(0);
});

function fixture() {
  const status: AutoStatus = {
    schemaVersion: 1,
    pid: 1,
    workspaceId: "w",
    running: true,
    connection: "connected",
    lastCheckAt: null,
    lastSyncAt: null,
    observedRevision: null,
    appliedRevision: "r1",
    outcome: "starting",
    lastErrorCode: null,
    retries: 0,
  };
  let head = "r1";
  let calls = 0;
  let checks = 0;
  let result: V2SyncResult = {
    kind: "synced",
    state: { lastAppliedRevision: "r1" },
    snapshot: { desired: { revisionId: "r1" } },
  } as V2SyncResult;
  let block: Promise<void> | undefined;
  const scheduler = new AutoSyncScheduler({
    status,
    revision: async () => {
      checks++;
      return head;
    },
    sync: async () => {
      calls++;
      await block;
      return result;
    },
    persist: async () => {},
    debounceMs: 2,
    retryDelay: () => 60_000,
  });
  return {
    status,
    scheduler,
    calls: () => calls,
    checks: () => checks,
    head: (v: string) => {
      head = v;
    },
    result: (v: V2SyncResult) => {
      result = v;
    },
    block: (v: Promise<void>) => {
      block = v;
    },
  };
}

test("startup verifies fully even if the local revision is current; idle checks are metadata-only", async () => {
  const f = fixture();
  await f.scheduler.flush();
  expect(f.calls()).toBe(1);
  expect(f.checks()).toBe(0);
  await f.scheduler.flush();
  expect(f.calls()).toBe(1);
  expect(f.checks()).toBe(1);
  f.head("r2");
  await f.scheduler.flush();
  expect(f.calls()).toBe(2);
  // Ack pulled snapshot, not the potentially newer metadata head.
  expect(f.status.appliedRevision).toBe("r1");
  await f.scheduler.stop();
});

test("partial with zero operations and report failure remain retryable on the same revision", async () => {
  const f = fixture();
  f.result({
    kind: "partial",
    operations: [],
    state: { lastAppliedRevision: "r0" },
    snapshot: { desired: { revisionId: "r1" }, plan: { classifications: [] } },
  } as unknown as V2SyncResult);
  await f.scheduler.flush();
  expect(f.status.appliedRevision).toBe("r1");
  expect(f.status.outcome).toBe("partial");
  expect(f.status.lastSyncAt).toBeNull();
  expect(f.status.lastErrorCode).toBe("PARTIAL_SYNC");
  await f.scheduler.flush();
  expect(f.calls()).toBe(2);
  f.result({
    kind: "synced",
    reportError: "do not persist token",
    state: { lastAppliedRevision: "r1" },
    snapshot: { desired: { revisionId: "r1" } },
  } as V2SyncResult);
  await f.scheduler.flush();
  await f.scheduler.flush();
  expect(f.calls()).toBe(4);
  expect(f.status.retries).toBe(4);
  expect(JSON.stringify(f.status)).not.toContain("token");
  await f.scheduler.stop();
});

test("event bursts debounce and events during a run schedule one trailing check without overlap", async () => {
  const f = fixture();
  let release!: () => void;
  f.block(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const initial = f.scheduler.flush();
  await Bun.sleep(1);
  for (let i = 0; i < 100; i++) f.scheduler.request();
  expect(f.calls()).toBe(1);
  release();
  await initial;
  await Bun.sleep(15);
  expect(f.calls()).toBe(1);
  expect(f.checks()).toBe(1);
  await f.scheduler.stop();
  f.scheduler.request();
  await f.scheduler.flush();
  expect(f.checks()).toBe(1);
});

test("retry backoff is exponential jittered and capped; revision payload is bounded", () => {
  expect(autoRetryDelay(0, () => 0)).toBe(500);
  expect(autoRetryDelay(2, () => 1)).toBe(4000);
  expect(autoRetryDelay(1000, () => 1)).toBe(300_000);
  expect(revisionFromMetadata({ revisionId: "" })).toBe("");
  expect(() => revisionFromMetadata({ revisionId: "r".repeat(257) })).toThrow();
  expect(() => revisionFromMetadata({ revisionId: 2 })).toThrow();
});

test("status overwrites atomically and remains bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corotum-auto-test-"));
  try {
    const file = join(directory, "auto-status.json");
    const store = new AutoStatusStore(file);
    expect(await store.load()).toBeNull();
    const f = fixture();
    await store.save(f.status);
    f.status.retries = 100;
    await store.save(f.status);
    expect((await store.load())?.retries).toBe(100);
    expect((await readFile(file, "utf8")).length).toBeLessThan(8192);
    await f.scheduler.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
