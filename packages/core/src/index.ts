export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type SkillId = Brand<string, "SkillId">;
export type RevisionId = Brand<string, "RevisionId">;

const skillIdPattern = /^sk_[A-Za-z0-9]+$/;

/** Validates an externally supplied stable skill identifier. */
export function skillId(value: string): SkillId {
  if (!skillIdPattern.test(value)) {
    throw new DomainValidationError(
      "INVALID_SKILL_ID",
      "A skill ID must have the form sk_<opaque identifier>.",
    );
  }

  return value as SkillId;
}

export function revisionId(value: string): RevisionId {
  if (value.trim().length === 0) {
    throw new DomainValidationError(
      "INVALID_REVISION_ID",
      "A revision ID cannot be empty.",
    );
  }

  return value as RevisionId;
}

export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DEVICE_ERROR"
  | "INVALID_REVISION_ID"
  | "INVALID_SKILL_ID"
  | "NETWORK_ERROR"
  | "VALIDATION_ERROR";

export class DomainValidationError extends Error {
  readonly name = "DomainValidationError";

  constructor(
    readonly code: Extract<
      DomainErrorCode,
      "INVALID_REVISION_ID" | "INVALID_SKILL_ID" | "VALIDATION_ERROR"
    >,
    message: string,
  ) {
    super(message);
  }
}

export type DomainError = Readonly<{
  code: DomainErrorCode;
  message: string;
}>;

export type Result<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{ kind: "partial"; value: T; errors: readonly DomainError[] }>
  | Readonly<{ kind: "failure"; error: DomainError }>;

export type DesiredState = Readonly<{
  manifest: unknown;
  lockfile: unknown;
}>;

export type ActualState = Readonly<{
  skills: Readonly<Record<SkillId, ActualSkillState>>;
}>;

export type ActualSkillState = Readonly<{
  contentHash: string | null;
  managed: boolean;
}>;

export type DesiredStateEnvelope = Readonly<{
  revisionId: RevisionId;
  revisionSequence?: number;
  state: DesiredState;
}>;

export type PushDesiredStateInput = Readonly<{
  state: DesiredState;
  baseRevision: RevisionId | null;
  idempotencyKey?: string;
}>;

/** Portable contract implemented by Git and Cloud state providers. */
export interface StateProvider {
  pull(): Promise<Result<DesiredStateEnvelope>>;
  push(input: PushDesiredStateInput): Promise<Result<DesiredStateEnvelope>>;
}
