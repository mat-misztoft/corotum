export const CLI_SCHEMA_VERSION = 1 as const;

export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  PARTIAL_SUCCESS: 2,
  CONFLICT: 3,
  AUTH_REQUIRED: 4,
  INVALID_CONFIG: 5,
  NETWORK_ERROR: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type CliOutcome = keyof typeof ExitCode;

export type JsonEnvelope<Payload extends Record<string, unknown>> = Readonly<
  { schemaVersion: typeof CLI_SCHEMA_VERSION } & Payload
>;

export function jsonEnvelope<Payload extends Record<string, unknown>>(
  payload: Payload,
): JsonEnvelope<Payload> {
  return { schemaVersion: CLI_SCHEMA_VERSION, ...payload };
}

export function exitCodeFor(outcome: CliOutcome): ExitCode {
  return ExitCode[outcome];
}
