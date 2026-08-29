const COMMANDS = new Set([
  "init",
  "add",
  "adopt",
  "remove",
  "unmanage",
  "restore",
  "update",
  "set-ref",
  "sync",
  "status",
  "diff",
  "config",
  "login",
  "logout",
]);

const OUTCOMES = new Set([
  "SUCCESS",
  "PARTIAL_SUCCESS",
  "GENERAL_ERROR",
  "CONFLICT",
  "AUTH_REQUIRED",
  "INVALID_CONFIG",
  "NETWORK_ERROR",
]);
const AGENTS = new Set([
  "codex",
  "claude-code",
  "pi",
  "gemini-cli",
  "opencode",
  "cursor",
  "windsurf",
  "cline",
  "roo-code",
  "github-copilot",
  "kiro-cli",
]);
const OPERATING_SYSTEMS = new Set(["darwin", "linux", "win32"]);
const ARCHITECTURES = new Set(["arm64", "x64"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export type AnonymousTelemetryEvent = Readonly<{
  installationId: string;
  version: string;
  os: string;
  architecture: string;
  command: string;
  durationMs: number;
  outcome: string;
  errorCode: string | null;
  activeAgentCount: number;
  supportedAgentIds: readonly string[];
}>;

/** Strictly parses the CLI's anonymous, allowlisted event contract. */
export function parseAnonymousTelemetryEvent(
  value: unknown,
): AnonymousTelemetryEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event);
  const expected = [
    "installationId",
    "version",
    "os",
    "architecture",
    "command",
    "durationMs",
    "outcome",
    "errorCode",
    "activeAgentCount",
    "supportedAgentIds",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  )
    return null;
  if (
    typeof event.installationId !== "string" ||
    !UUID.test(event.installationId) ||
    typeof event.version !== "string" ||
    !VERSION.test(event.version) ||
    typeof event.os !== "string" ||
    !OPERATING_SYSTEMS.has(event.os) ||
    typeof event.architecture !== "string" ||
    !ARCHITECTURES.has(event.architecture) ||
    typeof event.command !== "string" ||
    !COMMANDS.has(event.command) ||
    typeof event.durationMs !== "number" ||
    !Number.isSafeInteger(event.durationMs) ||
    event.durationMs < 0 ||
    event.durationMs > 86_400_000 ||
    typeof event.outcome !== "string" ||
    !OUTCOMES.has(event.outcome) ||
    (event.errorCode !== null &&
      (typeof event.errorCode !== "string" ||
        !OUTCOMES.has(event.errorCode))) ||
    typeof event.activeAgentCount !== "number" ||
    !Number.isSafeInteger(event.activeAgentCount) ||
    event.activeAgentCount < 0 ||
    event.activeAgentCount > AGENTS.size ||
    !Array.isArray(event.supportedAgentIds) ||
    event.supportedAgentIds.length > AGENTS.size ||
    event.supportedAgentIds.some(
      (agent) => typeof agent !== "string" || !AGENTS.has(agent),
    ) ||
    new Set(event.supportedAgentIds).size !== event.supportedAgentIds.length
  )
    return null;

  return event as AnonymousTelemetryEvent;
}

/** Writes only anonymous fields to Analytics Engine; never pair installation IDs with Cloud identities. */
export function ingestAnonymousTelemetry(
  analytics: AnalyticsEngineDataset,
  event: AnonymousTelemetryEvent,
) {
  analytics.writeDataPoint({
    indexes: [event.installationId],
    blobs: [
      event.version,
      event.os,
      event.architecture,
      event.command,
      event.outcome,
      event.errorCode ?? "NONE",
      [...event.supportedAgentIds].sort().join(","),
    ],
    doubles: [
      event.durationMs,
      event.activeAgentCount,
      event.supportedAgentIds.length,
    ],
  });
}
