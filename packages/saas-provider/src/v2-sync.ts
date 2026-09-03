import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";

import type { V2LockedSkill } from "../../core/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../skills-adapter/src/canonical-store";
import {
  ExactContentMaterializer,
  MaterializationError,
  type MaterializationErrorCode,
  mapMaterializationError,
} from "../../skills-adapter/src/exact-materializer";
import { scanNormalizedContent } from "../../skills-adapter/src/normalized-content";
import {
  type DeviceSyncReportPayload,
  type DeviceSyncReportReceipt,
  type DeviceSyncStatus,
  type DeviceTargetReport,
  type DeviceTargetStatus,
  postDeviceSyncReport,
} from "./sync-report";
import { V2CloudProviderError, type V2SaaSProvider } from "./v2-provider";

export type ApplicableTarget = Readonly<{
  skillId: string;
  agentId: string;
  path: string;
}>;

export type LastVerifiedCanonical = Readonly<{
  skillId: string;
  path: string;
  contentHash: string;
}>;

export type LastVerifiedLocalState = Readonly<{
  appliedRevisionId: string | null;
  canonical: Readonly<Record<string, LastVerifiedCanonical>>;
}>;

export type V2CloudSkillResult = Readonly<{
  skillId: string;
  name: string;
  code?: MaterializationErrorCode;
  contentHash?: string;
}>;

export type V2CloudSyncResult = Readonly<{
  lastVerified: LastVerifiedLocalState;
  report: DeviceSyncReportPayload | null;
  receipt: DeviceSyncReportReceipt | null;
  skillResults: readonly V2CloudSkillResult[];
}>;

/**
 * Pulls v2 Cloud desired state, materializes with the lock's transport, verifies
 * canonical and every applicable target, then reports. CLI wiring is T103.
 */
export class V2CloudNormalSync {
  constructor(
    private readonly provider: V2SaaSProvider,
    private readonly options: Readonly<{
      origin: string;
      deviceId: string;
      deviceToken: string;
      fetch?: typeof fetch;
      cliVersion?: string;
      git?: ConstructorParameters<typeof ExactContentMaterializer>[0];
    }>,
  ) {}

  async sync(
    input: Readonly<{
      lastVerified: LastVerifiedLocalState;
      canonicalRoot: string;
      targets: readonly ApplicableTarget[];
    }>,
  ): Promise<V2CloudSyncResult> {
    let pulled: Awaited<ReturnType<V2SaaSProvider["pull"]>>;
    try {
      pulled = await this.provider.pull();
    } catch (error) {
      const mapped = mapCloudError(error, "source");
      return {
        lastVerified: input.lastVerified,
        report: null,
        receipt: null,
        skillResults: [{ skillId: "sk_pull", name: "pull", code: mapped.code }],
      };
    }

    const store = new CanonicalSkillStore(input.canonicalRoot);
    const canonical: Record<string, LastVerifiedCanonical> = {
      ...input.lastVerified.canonical,
    };
    const skillResults: V2CloudSkillResult[] = [];
    const targetReports: DeviceTargetReport[] = [];
    let verificationComplete = true;

    for (const lock of pulled.state.lockfile.skills) {
      const expected = expectedHash(lock);
      try {
        const staged = await this.stageLock(lock);
        try {
          const existing = canonical[lock.id];
          let ownership:
            | { skillId: typeof lock.id; contentHash: string; allowDrift: true }
            | undefined;
          if (existing?.skillId === lock.id) {
            const actual = await scanNormalizedContent(existing.path);
            if (actual.contentHash !== existing.contentHash) {
              throw new MaterializationError(
                "DRIFTED",
                "Canonical content differs from the last verified copy.",
              );
            }
            // CanonicalSkillStore predates normalized v2 hashes. We verified the
            // recorded normalized hash above, so its legacy hash check is not an
            // ownership signal for a v2 managed copy.
            ownership = {
              skillId: lock.id,
              contentHash: existing.contentHash,
              allowDrift: true,
            };
          }
          await store.replaceFromDirectory(
            lock.id,
            lock.name,
            staged.directory,
            await hashSkillDirectory(staged.directory),
            ownership,
          );
        } finally {
          await staged.cleanup();
        }
        const path = store.pathFor(lock.name);
        const scanned = await scanNormalizedContent(path);
        if (scanned.contentHash !== expected) {
          throw new MaterializationError(
            "CONTENT_HASH_MISMATCH",
            "Canonical content does not match the locked hash.",
          );
        }
        canonical[lock.id] = {
          skillId: lock.id,
          path,
          contentHash: scanned.contentHash,
        };
        skillResults.push({
          skillId: lock.id,
          name: lock.name,
          contentHash: scanned.contentHash,
        });
        for (const target of input.targets.filter(
          (item) => item.skillId === lock.id,
        )) {
          const report = await verifyTarget(target, path, scanned.contentHash);
          targetReports.push(report);
          if (report.status !== "SYNCED") verificationComplete = false;
        }
      } catch (error) {
        verificationComplete = false;
        const mapped = mapCloudError(error, lock.materialization.kind);
        skillResults.push({
          skillId: lock.id,
          name: lock.name,
          code: mapped.code,
        });
        for (const target of input.targets.filter(
          (item) => item.skillId === lock.id,
        )) {
          targetReports.push({
            skillId: target.skillId,
            agentId: target.agentId,
            status: statusFrom(mapped.code),
            errorCode: mapped.code,
            errorMessage: mapped.message,
            contentHash: null,
          });
        }
      }
    }

    const syncStatus = aggregateStatus(targetReports, skillResults);
    if (syncStatus === "SYNCED" && skillResults.some((result) => result.code)) {
      throw new Error("A failed skill cannot be reported as SYNCED.");
    }
    const appliedRevisionId =
      verificationComplete && pulled.revisionId
        ? pulled.revisionId
        : input.lastVerified.appliedRevisionId;
    const failed = skillResults.find((result) => result.code);
    const report: DeviceSyncReportPayload = {
      appliedRevisionId,
      syncStatus,
      lastErrorCode: failed?.code ?? null,
      lastErrorMessage: failed?.code ?? null,
      targets: targetReports,
    };

    const lastVerified: LastVerifiedLocalState = {
      appliedRevisionId,
      canonical,
    };
    const posted = await postDeviceSyncReport({
      origin: this.options.origin,
      deviceId: this.options.deviceId,
      deviceToken: this.options.deviceToken,
      cliVersion: this.options.cliVersion,
      fetch: this.options.fetch,
      report,
    });
    return {
      lastVerified,
      report,
      receipt: posted.kind === "success" ? posted.value : null,
      skillResults,
    };
  }

  private async stageLock(lock: V2LockedSkill) {
    if (lock.materialization.kind === "source") {
      return new ExactContentMaterializer(this.options.git).stage(lock);
    }
    const provider = this.provider;
    return new ExactContentMaterializer(this.options.git, async (locator) => {
      if (
        lock.materialization.kind !== "artifact" ||
        locator !== lock.materialization.artifact.locator
      ) {
        throw new MaterializationError(
          "ARTIFACT_UNAVAILABLE",
          "Artifact reader refused a source or mismatched locator.",
        );
      }
      try {
        return await provider.downloadArtifact(lock);
      } catch (error) {
        throw mapCloudError(error, "artifact");
      }
    }).stage(lock);
  }
}

function expectedHash(lock: V2LockedSkill): `sha256:${string}` {
  return lock.materialization.kind === "source"
    ? lock.materialization.contentHash
    : lock.materialization.artifact.contentHash;
}

function mapCloudError(
  error: unknown,
  transport: "source" | "artifact",
): MaterializationError {
  if (error instanceof MaterializationError) return error;
  if (error instanceof V2CloudProviderError) {
    if (
      error.code === "AUTH_REQUIRED" ||
      error.code === "ARTIFACT_UNAVAILABLE" ||
      error.code === "CONTENT_HASH_MISMATCH" ||
      error.code === "NETWORK_ERROR"
    ) {
      return new MaterializationError(error.code, error.message);
    }
    return new MaterializationError(
      transport === "artifact" ? "ARTIFACT_UNAVAILABLE" : "SOURCE_UNAVAILABLE",
      error.message,
    );
  }
  return mapMaterializationError(error, transport);
}

function statusFrom(code: MaterializationErrorCode): DeviceTargetStatus {
  if (code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (code === "DRIFTED") return "DRIFTED";
  return "ERROR";
}

async function verifyTarget(
  target: ApplicableTarget,
  canonicalPath: string,
  expected: string,
): Promise<DeviceTargetReport> {
  try {
    const metadata = await lstat(target.path);
    if (metadata.isSymbolicLink()) {
      const linked = resolve(target.path, "..", await readlink(target.path));
      if (resolve(linked) !== resolve(canonicalPath)) {
        return {
          skillId: target.skillId,
          agentId: target.agentId,
          status: "DRIFTED",
          errorCode: "DRIFTED",
          errorMessage:
            "Target symlink does not point at the verified canonical copy.",
          contentHash: null,
        };
      }
      return {
        skillId: target.skillId,
        agentId: target.agentId,
        status: "SYNCED",
        contentHash: expected,
      };
    }
    const actual = await hashSkillDirectory(target.path);
    if (actual !== expected) {
      return {
        skillId: target.skillId,
        agentId: target.agentId,
        status: "DRIFTED",
        errorCode: "DRIFTED",
        errorMessage:
          "Target content does not match the verified canonical copy.",
        contentHash: actual,
      };
    }
    return {
      skillId: target.skillId,
      agentId: target.agentId,
      status: "SYNCED",
      contentHash: actual,
    };
  } catch (error) {
    return {
      skillId: target.skillId,
      agentId: target.agentId,
      status: "ERROR",
      errorCode: "LOCAL_CONFLICT",
      errorMessage: "Target verification failed.",
      contentHash: null,
    };
  }
}

function aggregateStatus(
  targets: readonly DeviceTargetReport[],
  skills: readonly V2CloudSkillResult[],
): DeviceSyncStatus {
  if (
    skills.some((skill) => skill.code) ||
    targets.some((target) => target.status !== "SYNCED")
  ) {
    if (
      targets.some((target) => target.status === "DRIFTED") &&
      targets.every(
        (target) => target.status === "SYNCED" || target.status === "DRIFTED",
      ) &&
      !skills.some((skill) => skill.code)
    ) {
      return "DRIFTED";
    }
    if (
      targets.some((target) => target.status === "SYNCED") ||
      skills.some((skill) => !skill.code)
    ) {
      return "PARTIALLY_SYNCED";
    }
    return "ERROR";
  }
  return "SYNCED";
}
