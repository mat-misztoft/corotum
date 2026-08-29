import {
  type DesiredState,
  type DesiredStateEnvelope,
  DomainValidationError,
  type PushDesiredStateInput,
  type Result,
  type RevisionTransition,
  revisionId,
  type StateProvider,
  validateDesiredState,
} from "../../core/src/index";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./headers";

export {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./headers";
export {
  DEVICE_SYNC_STATUSES,
  type DeviceSyncReportPayload,
  type DeviceSyncReportReceipt,
  type DeviceSyncStatus,
  type PostDeviceSyncReportOptions,
  postDeviceSyncReport,
} from "./sync-report";
/** Provider-local stand-in for a Cloud workspace that has no revision yet. */
export const UNINITIALIZED_CLOUD_REVISION = revisionId("rev_uninitialized");

export type SaaSProviderOptions = Readonly<{
  origin: string;
  workspaceId: string;
  deviceToken: string;
  cliVersion?: string;
  fetch?: typeof fetch;
}>;

/**
 * Portable Cloud StateProvider. It only pulls and pushes desired state; login,
 * pairing, and device reporting stay outside this boundary.
 */
export class SaaSProvider implements StateProvider {
  private readonly origin: string;
  private readonly workspaceId: string;
  private readonly deviceToken: string;
  private readonly cliVersion: string;
  private readonly fetch: typeof fetch;

  constructor(options: SaaSProviderOptions) {
    const origin = new URL(options.origin);
    if (origin.username || origin.password) {
      throw new Error("Cloud origin must not include credentials.");
    }
    this.origin = origin.origin;
    this.workspaceId = options.workspaceId;
    this.deviceToken = options.deviceToken;
    this.cliVersion = options.cliVersion ?? "0.1.0";
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async pull(): Promise<Result<DesiredStateEnvelope>> {
    return this.request("GET");
  }

  async push(
    input: PushDesiredStateInput,
    transition?: RevisionTransition,
  ): Promise<Result<DesiredStateEnvelope>> {
    if (!transition) {
      return {
        kind: "failure",
        error: {
          code: "VALIDATION_ERROR",
          message: "A Cloud state mutation needs a transition.",
        },
      };
    }
    try {
      validateDesiredState(input.state, "cloud");
    } catch (error) {
      return validationFailure(error);
    }
    return this.request("PUT", {
      state: input.state,
      baseRevision:
        input.baseRevision === UNINITIALIZED_CLOUD_REVISION
          ? null
          : input.baseRevision,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      transition,
    });
  }

  private stateUrl() {
    return `${this.origin}/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/state`;
  }

  private async request(
    method: "GET" | "PUT",
    body?: Readonly<{
      state: DesiredState;
      baseRevision: string | null;
      idempotencyKey: string;
      transition: RevisionTransition;
    }>,
  ): Promise<Result<DesiredStateEnvelope>> {
    try {
      const headers = new Headers({
        [DEVICE_TOKEN_HEADER]: this.deviceToken,
        [CLI_VERSION_HEADER]: this.cliVersion,
      });
      if (body) {
        headers.set(IDEMPOTENCY_KEY_HEADER, body.idempotencyKey);
        headers.set("content-type", "application/json");
      }
      const response = await this.fetch(this.stateUrl(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await readEnvelope(response);
    } catch (error) {
      if (error instanceof DomainValidationError)
        return validationFailure(error);
      return {
        kind: "failure",
        error: {
          code: "NETWORK_ERROR",
          message:
            error instanceof Error ? error.message : "Cloud request failed.",
        },
      };
    }
  }
}

function validationFailure(error: unknown): Result<DesiredStateEnvelope> {
  return {
    kind: "failure",
    error: {
      code: "VALIDATION_ERROR",
      message:
        error instanceof Error ? error.message : "Invalid desired state.",
    },
  };
}

async function readEnvelope(
  response: Response,
): Promise<Result<DesiredStateEnvelope>> {
  if (response.status === 401) {
    return {
      kind: "failure",
      error: {
        code: "AUTH_REQUIRED",
        message: "Cloud device authentication failed.",
      },
    };
  }
  if (response.status === 409) {
    return {
      kind: "failure",
      error: {
        code: "CONFLICT",
        message: "Cloud desired state has changed.",
      },
    };
  }
  if (response.status === 426) {
    return {
      kind: "failure",
      error: { code: "DEVICE_ERROR", message: "CLI upgrade required." },
    };
  }
  if (!response.ok) {
    return {
      kind: "failure",
      error: {
        code: response.status === 400 ? "VALIDATION_ERROR" : "NETWORK_ERROR",
        message: await responseMessage(response),
      },
    };
  }

  const payload = (await response.json()) as {
    revisionId?: string | null;
    revisionSequence?: number;
    state?: DesiredState;
  };
  if (!payload || typeof payload !== "object" || !payload.state) {
    return {
      kind: "failure",
      error: {
        code: "VALIDATION_ERROR",
        message: "Cloud returned invalid desired state.",
      },
    };
  }
  return {
    kind: "success",
    value: {
      revisionId: payload.revisionId
        ? revisionId(payload.revisionId)
        : UNINITIALIZED_CLOUD_REVISION,
      revisionSequence: payload.revisionSequence,
      state: validateDesiredState(payload.state, "cloud"),
    },
  };
}

async function responseMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim())
      return payload.error;
  } catch {
    // Fall through to the status text when the body is not JSON.
  }
  return response.statusText || "Cloud request failed.";
}
