import {
  type DispositionLedger,
  DomainValidationError,
  parseDispositionLedger,
  type RevisionTransition,
  skillId,
  type V2DesiredState,
  type V2LockedSkill,
  validateV2DesiredState,
} from "../../core/src/index";
import {
  ARTIFACT_DESCRIPTOR_HEADER,
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./headers";

export type V2SaaSProviderOptions = Readonly<{
  origin: string;
  workspaceId: string;
  deviceToken: string;
  cliVersion?: string;
  fetch?: typeof fetch;
}>;

export type V2CloudStateEnvelope = Readonly<{
  revisionId: string | null;
  revisionSequence: number;
  state: V2DesiredState;
  ledger: DispositionLedger;
}>;

export type V2CloudPushInput = Readonly<{
  state: V2DesiredState;
  ledger: DispositionLedger;
  baseRevision: string | null;
  artifacts?: Readonly<Record<string, Uint8Array>>;
  idempotencyKey?: string;
  transition?: RevisionTransition;
  transitions?: readonly RevisionTransition[];
}>;

export class V2CloudProviderError extends Error {
  readonly name = "V2CloudProviderError";
  constructor(
    readonly code:
      | "AUTH_REQUIRED"
      | "ARTIFACT_UNAVAILABLE"
      | "CONTENT_HASH_MISMATCH"
      | "NETWORK_ERROR"
      | "VALIDATION_ERROR"
      | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Cloud v2 desired-state, disposition-ledger and artifact transport. Reporting
 * and CLI reconcile stay outside this class.
 */
export class V2SaaSProvider {
  private readonly origin: string;
  private readonly workspaceId: string;
  private readonly deviceToken: string;
  private readonly cliVersion: string;
  private readonly fetch: typeof fetch;

  constructor(options: V2SaaSProviderOptions) {
    const origin = new URL(options.origin);
    if (origin.username || origin.password) {
      throw new V2CloudProviderError(
        "VALIDATION_ERROR",
        "Cloud origin must not include credentials.",
      );
    }
    this.origin = origin.origin;
    this.workspaceId = options.workspaceId;
    this.deviceToken = options.deviceToken;
    this.cliVersion = options.cliVersion ?? "0.1.0";
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async pull(): Promise<V2CloudStateEnvelope> {
    return this.readEnvelope(
      await this.send(this.stateUrl(), { method: "GET" }),
    );
  }

  async push(input: V2CloudPushInput): Promise<V2CloudStateEnvelope> {
    const state = validateV2DesiredState(input.state);
    const ledger = parseDispositionLedger(JSON.stringify(input.ledger));
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    for (const [id, bytes] of Object.entries(input.artifacts ?? {})) {
      const lock = state.lockfile.skills.find((skill) => skill.id === id);
      if (!lock) {
        throw new V2CloudProviderError(
          "VALIDATION_ERROR",
          "Artifact supplied for a skill that is not in desired state.",
        );
      }
      await this.uploadArtifact(lock, bytes);
    }
    return this.readEnvelope(
      await this.send(this.stateUrl(), {
        method: "PUT",
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        body: JSON.stringify({
          state,
          baseRevision: input.baseRevision,
          idempotencyKey,
          transition:
            input.transition ??
            input.transitions?.[0] ??
            synthesizedTransition(state, ledger),
          transitions: input.transitions,
          dispositionLedger: ledger,
        }),
      }),
    );
  }

  /** Authenticated R2 download for artifact locks only; source locks never hit R2. */
  async downloadArtifact(lock: V2LockedSkill): Promise<Uint8Array> {
    const transfer = artifactTransfer(this.workspaceId, lock);
    const response = await this.send(this.artifactUrl(), {
      method: "GET",
      headers: { [ARTIFACT_DESCRIPTOR_HEADER]: JSON.stringify(transfer) },
    });
    if (response.status === 401) {
      throw new V2CloudProviderError("AUTH_REQUIRED", "Cloud device authentication failed.");
    }
    if (response.status === 404) {
      throw new V2CloudProviderError("ARTIFACT_UNAVAILABLE", "Artifact object is missing.");
    }
    if (!response.ok) {
      throw await this.failureFrom(response, "artifact");
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async uploadArtifact(lock: V2LockedSkill, bytes: Uint8Array): Promise<void> {
    const transfer = artifactTransfer(this.workspaceId, lock);
    const response = await this.send(this.artifactUrl(), {
      method: "PUT",
      headers: {
        [ARTIFACT_DESCRIPTOR_HEADER]: JSON.stringify(transfer),
        "content-type": "application/octet-stream",
      },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) throw await this.failureFrom(response, "artifact");
  }

  private stateUrl() {
    return `${this.origin}/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/state`;
  }

  private artifactUrl() {
    return `${this.origin}/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/artifacts`;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set(DEVICE_TOKEN_HEADER, this.deviceToken);
    headers.set(CLI_VERSION_HEADER, this.cliVersion);
    return headers;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      const headers = this.headers(init.headers);
      if (init.body && typeof init.body === "string" && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return await this.fetch(url, { ...init, headers });
    } catch (error) {
      throw new V2CloudProviderError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Cloud request failed.",
      );
    }
  }

  private async readEnvelope(response: Response): Promise<V2CloudStateEnvelope> {
    if (!response.ok) throw await this.failureFrom(response, "state");
    const payload = (await response.json()) as {
      revisionId?: string | null;
      revisionSequence?: number;
      state?: unknown;
      dispositionLedger?: unknown;
      ledger?: unknown;
    };
    if (!payload || typeof payload !== "object" || payload.state == null) {
      throw new V2CloudProviderError("VALIDATION_ERROR", "Cloud returned invalid desired state.");
    }
    const ledgerSource = payload.dispositionLedger ?? payload.ledger ?? { version: 2, activeDispositions: {} };
    try {
      return {
        revisionId: payload.revisionId ?? null,
        revisionSequence: payload.revisionSequence ?? 0,
        state: uninitializedEmptyV2State(payload) ?? validateV2DesiredState(payload.state as V2DesiredState),
        ledger: parseDispositionLedger(JSON.stringify(ledgerSource)),
      };
    } catch (error) {
      if (error instanceof DomainValidationError) {
        throw new V2CloudProviderError("VALIDATION_ERROR", error.message);
      }
      throw error;
    }
  }

  private async failureFrom(response: Response, transport: "state" | "artifact"): Promise<V2CloudProviderError> {
    const message = await responseMessage(response);
    if (response.status === 401) return new V2CloudProviderError("AUTH_REQUIRED", "Cloud device authentication failed.");
    if (response.status === 402) {
      return new V2CloudProviderError(
        "NETWORK_ERROR",
        /subscription required/i.test(message)
          ? message
          : "Hosted Cloud subscription required",
      );
    }
    if (response.status === 409) return new V2CloudProviderError("CONFLICT", message);
    if (response.status === 404 && transport === "artifact") {
      return new V2CloudProviderError("ARTIFACT_UNAVAILABLE", message);
    }
    if (response.status === 400 && /hash|integrity|size/i.test(message)) {
      return new V2CloudProviderError("CONTENT_HASH_MISMATCH", message);
    }
    if (response.status === 400) return new V2CloudProviderError("VALIDATION_ERROR", message);
    return new V2CloudProviderError("NETWORK_ERROR", message);
  }
}

const emptyV2State: V2DesiredState = {
  manifest: { version: 2, skills: [] },
  lockfile: { version: 2, skills: [] },
};

/** An uninitialized workspace still serializes the v1 empty snapshot. */
function uninitializedEmptyV2State(payload: {
  revisionId?: string | null;
  state?: unknown;
}): V2DesiredState | null {
  if (payload.revisionId != null) return null;
  const state = payload.state as {
    manifest?: { version?: unknown; skills?: unknown };
    lockfile?: { skills?: unknown };
  } | null;
  if (!state || (state.manifest?.version !== 1 && state.manifest?.version !== 2)) {
    return null;
  }
  if (!Array.isArray(state.manifest?.skills) || state.manifest.skills.length > 0) {
    return null;
  }
  if (!Array.isArray(state.lockfile?.skills) || state.lockfile.skills.length > 0) {
    return null;
  }
  return emptyV2State;
}

function artifactTransfer(workspaceId: string, lock: V2LockedSkill) {
  if (lock.materialization.kind !== "artifact") {
    throw new V2CloudProviderError(
      "VALIDATION_ERROR",
      "Authenticated artifact download is only valid for artifact locks.",
    );
  }
  const artifact = lock.materialization.artifact;
  if (artifact.kind !== "r2-tar-zst") {
    throw new V2CloudProviderError(
      "VALIDATION_ERROR",
      "Cloud content artifacts must be r2-tar-zst.",
    );
  }
  const expected = `workspaces/${workspaceId}/artifacts/${lock.id}/${artifact.integrityHash}.tar.zst`;
  if (artifact.locator !== expected) {
    throw new V2CloudProviderError("VALIDATION_ERROR", "Artifact locator is not valid for this workspace.");
  }
  return { skillId: lock.id, artifact };
}

function synthesizedTransition(
  state: V2DesiredState,
  ledger: DispositionLedger,
): RevisionTransition {
  const skill =
    state.lockfile.skills[0]?.id ??
    (Object.keys(ledger.activeDispositions)[0] as string | undefined) ??
    "sk_v2push";
  return { type: "UPDATE", skillId: skillId(skill), metadata: { v2: "sync" } };
}

async function responseMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  } catch {
    // Fall through to the status text when the body is not JSON.
  }
  return response.statusText || "Cloud request failed.";
}
