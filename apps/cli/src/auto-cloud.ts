import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
} from "../../../packages/saas-provider/src/headers";
import { revisionFromMetadata } from "./auto-sync";
import { CloudAuthError } from "./cloud-auth";

export type AutoCloudContext = {
  origin: string;
  workspaceId: string;
  token: string;
  cliVersion: string;
};
export function autoCloudHeaders(context: AutoCloudContext) {
  return {
    [DEVICE_TOKEN_HEADER]: context.token,
    [CLI_VERSION_HEADER]: context.cliVersion,
  };
}
export function autoCloudEndpoint(context: AutoCloudContext) {
  const url = new URL(context.origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new CloudAuthError(
      "Automatic Cloud sync requires HTTPS (except loopback development).",
      "INVALID_CONFIG",
    );
  }
  return `${url.origin}/api/v2/workspaces/${encodeURIComponent(context.workspaceId)}`;
}
export class AutoRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Cloud automatic sync is rate limited; retry later.");
  }
}
export function retryAfterMs(header: string | null, now = Date.now()): number {
  const seconds = header === null ? NaN : Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : header
      ? Date.parse(header) - now
      : NaN;
  return Number.isFinite(delay)
    ? Math.max(1000, Math.min(3_600_000, delay))
    : 60_000;
}
export async function readAutoRevision(context: AutoCloudContext) {
  const response = await fetch(`${autoCloudEndpoint(context)}/revision`, {
    headers: autoCloudHeaders(context),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if ([401, 402, 403, 404].includes(response.status))
    throw new CloudAuthError(
      "Cloud device authentication failed. Check pairing, workspace access and Cloud entitlement.",
      "AUTH_REQUIRED",
    );
  if (response.status === 429)
    throw new AutoRateLimitError(
      retryAfterMs(response.headers.get("retry-after")),
    );
  if (!response.ok)
    throw new Error(
      "Cloud revision metadata is unavailable. Check Cloud automatic-sync deployment and try again.",
    );
  const body = await response.text();
  if (body.length > 8192)
    throw new Error("Cloud revision metadata exceeds its size limit.");
  const value: unknown = JSON.parse(body);
  const revisionId = revisionFromMetadata(value);
  const sequence =
    value && typeof value === "object" && "revisionSequence" in value
      ? value.revisionSequence
      : undefined;
  return {
    revisionId,
    revisionSequence:
      typeof sequence === "number" &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0
        ? sequence
        : null,
  };
}
export function createAutoSocket(context: AutoCloudContext): WebSocket {
  const url = new URL(`${autoCloudEndpoint(context)}/events`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // lib.dom hides Bun's custom-header constructor in the mixed web/CLI workspace.
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocket(url.href, { headers: autoCloudHeaders(context) });
}

/** Enable must prove both authenticated endpoints are deployed before touching native services. */
export async function probeAutoCloud(
  context: AutoCloudContext,
  timeoutMs = 10_000,
): Promise<void> {
  await readAutoRevision(context);
  await new Promise<void>((resolve, reject) => {
    const socket = createAutoSocket(context);
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(success: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (success) resolve();
      else
        reject(
          new Error(
            "Cloud automatic-sync events are unavailable. Deploy/configure the events service, then retry corotum auto enable.",
          ),
        );
    }
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
  });
}

/** Events are ordered hints; never accept another workspace or replay an older sequence. */
export class RevisionEventGate {
  private sequence = -1;
  constructor(private readonly workspaceId: string) {}
  observe(sequence: number | null): void {
    if (sequence !== null) this.sequence = Math.max(this.sequence, sequence);
  }
  accepts(data: unknown): boolean {
    if (typeof data !== "string" || data.length > 8192) return false;
    try {
      const value = JSON.parse(data);
      if (
        value?.type !== "revision.updated" ||
        value.workspaceId !== this.workspaceId ||
        typeof value.revisionId !== "string" ||
        value.revisionId.length > 256 ||
        !Number.isSafeInteger(value.revisionSequence) ||
        value.revisionSequence < 0 ||
        value.revisionSequence <= this.sequence
      )
        return false;
      this.sequence = value.revisionSequence;
      return true;
    } catch {
      return false;
    }
  }
}
