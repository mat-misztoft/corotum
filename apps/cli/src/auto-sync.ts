import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { V2SyncResult } from "./v2-sync";

export const AUTO_FALLBACK_MS = 60 * 60 * 1000;
export async function runAutoSyncAwareCommand<T>(deps: {
  pendingUpdateApplied: boolean;
  loadToken: () => Promise<string | undefined>;
  restart: () => Promise<void>;
  run: () => Promise<T>;
  runUpdatedWorker?: () => Promise<T>;
}): Promise<T> {
  if (deps.pendingUpdateApplied && deps.runUpdatedWorker)
    return deps.runUpdatedWorker();
  if (deps.pendingUpdateApplied) await deps.restart();
  const previousToken = await deps.loadToken();
  try {
    return await deps.run();
  } finally {
    const token = await deps.loadToken();
    if (token && token !== previousToken) await deps.restart();
  }
}

export function autoRetryDelay(attempt: number, random = Math.random): number {
  return Math.round(
    Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)) *
      (0.5 + random() * 0.5),
  );
}

export type AutoStatus = {
  schemaVersion: 1;
  pid: number;
  workspaceId: string;
  running: boolean;
  connection: "connecting" | "connected" | "disconnected";
  lastCheckAt: string | null;
  lastSyncAt: string | null;
  observedRevision: string | null;
  appliedRevision: string | null;
  outcome: "starting" | "synced" | "partial" | "error" | "stopped";
  lastErrorCode:
    | "MUTATION_BUSY"
    | "LOCAL_CONFLICT"
    | "PARTIAL_SYNC"
    | "AUTH_REQUIRED"
    | "SYNC_FAILED"
    | "REPORT_FAILED"
    | null;
  retries: number;
};

/** Fixed-size metadata only: never persist remote errors, URLs, credentials, or skill contents. */
export class AutoStatusStore {
  constructor(private readonly file: string) {}
  async save(status: AutoStatus): Promise<void> {
    const encoded = `${JSON.stringify(status)}\n`;
    if (Buffer.byteLength(encoded) > 8192)
      throw new Error("Automatic sync status exceeds its size limit.");
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async load(): Promise<AutoStatus | null> {
    try {
      const text = await readFile(this.file, "utf8");
      if (text.length > 8192) return null;
      const value = JSON.parse(text);
      return value?.schemaVersion === 1 && Number.isSafeInteger(value.pid)
        ? value
        : null;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return null;
      throw error;
    }
  }
}

/** Serial, trailing-edge coalescing. Partial runs deliberately never acknowledge the desired revision. */
export class AutoSyncScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private verify = true;
  private retry = false;
  private blocked = false;
  private notBefore = 0;
  constructor(
    private readonly deps: {
      revision: () => Promise<string>;
      sync: () => Promise<V2SyncResult>;
      status: AutoStatus;
      persist: (status: AutoStatus) => Promise<void>;
      debounceMs?: number;
      retryDelay?: (attempt: number) => number;
    },
  ) {}

  request(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.flush();
      },
      Math.max(this.deps.debounceMs ?? 2000, this.notBefore - Date.now()),
    );
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.notBefore > Date.now()) {
      this.request();
      return;
    }
    if (this.active) {
      this.dirty = true;
      return this.active;
    }
    clearTimeout(this.timer);
    this.dirty = false;
    this.active = this.cycle();
    try {
      await this.active;
    } finally {
      this.active = undefined;
      if (!this.stopped && this.dirty) this.request();
      else if (!this.stopped && this.retry) {
        this.timer = setTimeout(
          () => {
            void this.flush();
          },
          Math.max(
            this.notBefore - Date.now(),
            this.blocked
              ? AUTO_FALLBACK_MS
              : (this.deps.retryDelay ?? autoRetryDelay)(
                  this.deps.status.retries - 1,
                ),
          ),
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  private async cycle(): Promise<void> {
    const status = this.deps.status;
    try {
      const revision = this.verify ? null : await this.deps.revision();
      status.lastCheckAt = new Date().toISOString();
      status.observedRevision = revision;
      if (this.verify || this.retry || revision !== status.appliedRevision) {
        const result = await this.deps.sync();
        this.retry =
          result.kind !== "synced" ||
          ("reportError" in result && Boolean(result.reportError));
        this.blocked =
          result.kind === "partial" &&
          result.operations.every(
            (op) =>
              op.status === "SUCCESS" ||
              op.status === "DRIFTED" ||
              op.status === "LOCAL_CONFLICT",
          ) &&
          result.snapshot.plan.classifications.some(
            (item) =>
              item.classification === "DRIFTED" ||
              item.classification === "LOCAL_CONFLICT",
          );
        status.lastErrorCode =
          result.kind === "synced"
            ? result.reportError
              ? "REPORT_FAILED"
              : null
            : result.kind === "partial"
              ? result.operations.some((op) => op.status === "AUTH_REQUIRED")
                ? "AUTH_REQUIRED"
                : this.blocked
                  ? "LOCAL_CONFLICT"
                  : "PARTIAL_SYNC"
              : "SYNC_FAILED";
        status.outcome =
          result.kind === "synced"
            ? "synced"
            : result.kind === "partial"
              ? "partial"
              : "error";
        if (result.kind === "synced") {
          status.lastSyncAt = new Date().toISOString();
          status.appliedRevision = result.state.lastAppliedRevision;
          // The head can change between metadata and pull; acknowledge only what was actually verified.
          status.observedRevision = result.snapshot.desired.revisionId;
        }
        this.verify = false;
      }
      status.retries = this.retry ? Math.min(status.retries + 1, 1000) : 0;
    } catch (error) {
      this.retry = true;
      status.outcome = "error";
      status.lastErrorCode =
        error instanceof Error && error.name === "MutationLockedError"
          ? "MUTATION_BUSY"
          : error instanceof Error &&
              "outcome" in error &&
              error.outcome === "AUTH_REQUIRED"
            ? "AUTH_REQUIRED"
            : "SYNC_FAILED";
      this.blocked = status.lastErrorCode === "AUTH_REQUIRED";
      status.retries = Math.min(status.retries + 1, 1000);
      if (
        error instanceof Error &&
        "retryAfterMs" in error &&
        typeof error.retryAfterMs === "number"
      )
        this.notBefore =
          Date.now() +
          Math.max(1000, Math.min(AUTO_FALLBACK_MS, error.retryAfterMs));
    }
    // A status disk failure must not turn a background timer into an unhandled rejection.
    await this.deps.persist({ ...status }).catch(() => undefined);
  }
}

export function revisionFromMetadata(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "revisionId" in value &&
    value.revisionId === null
  )
    return "";
  if (
    typeof value !== "object" ||
    value === null ||
    !("revisionId" in value) ||
    typeof value.revisionId !== "string" ||
    value.revisionId.length > 256
  ) {
    throw new Error("Invalid workspace revision metadata.");
  }
  return value.revisionId;
}
