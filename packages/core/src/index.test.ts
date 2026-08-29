import { describe, expect, test } from "bun:test";
import {
  type ActualState,
  type DesiredStateEnvelope,
  parseLockfile,
  parseManifest,
  type Result,
  revisionId,
  type StateProvider,
  serializeLockfile,
  serializeManifest,
  skillId,
  validateDesiredState,
} from "./index";

describe("portable core domain primitives", () => {
  test("keeps opaque skill IDs stable through serialization independent of display names", () => {
    const id = skillId("sk_01JXYZ");
    const serialized = JSON.stringify({ id, skill: "frontend-design" });
    const restored = JSON.parse(serialized) as { id: string; skill: string };

    expect(restored).toEqual({ id: "sk_01JXYZ", skill: "frontend-design" });
    expect(skillId(restored.id)).toBe(id);
    expect(skillId("sk_01JABC")).not.toBe(id);
  });

  test("rejects malformed stable skill IDs", () => {
    expect(() => skillId("frontend-design")).toThrow("sk_<opaque identifier>");
    expect(() => skillId("sk_")).toThrow("sk_<opaque identifier>");
  });

  test("represents desired, actual, and every provider failure vocabulary portably", async () => {
    const desired = {
      manifest: { version: 1 as const, skills: [] },
      lockfile: { version: 1 as const, skills: [] },
    };
    const actual: ActualState = {
      skills: { [skillId("sk_01JXYZ")]: { contentHash: null, managed: false } },
    };
    const envelope: DesiredStateEnvelope = {
      revisionId: revisionId("42"),
      state: desired,
    };
    const outcomes: readonly Result<DesiredStateEnvelope>[] = [
      { kind: "success", value: envelope },
      {
        kind: "partial",
        value: envelope,
        errors: [{ code: "DEVICE_ERROR", message: "one target failed" }],
      },
      { kind: "failure", error: { code: "CONFLICT", message: "stale" } },
      { kind: "failure", error: { code: "AUTH_REQUIRED", message: "login" } },
      {
        kind: "failure",
        error: { code: "VALIDATION_ERROR", message: "invalid input" },
      },
    ];
    const provider: StateProvider = {
      pull: async () => outcomes[0],
      push: async () => outcomes[0],
    };

    expect(actual.skills[skillId("sk_01JXYZ")]?.managed).toBeFalse();
    expect(await provider.pull()).toEqual(outcomes[0]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "success",
      "partial",
      "failure",
      "failure",
      "failure",
    ]);
  });
});

describe("deterministic manifest and lockfile schemas", () => {
  const manifest = {
    version: 1 as const,
    skills: [
      {
        id: skillId("sk_01JB"),
        source: "https://github.com/example/skills.git",
        skill: "code-review",
        ref: "main",
        targets: ["pi", "codex"] as const,
        resolutionStatus: "RESOLVED" as const,
      },
      {
        id: skillId("sk_01JA"),
        source: "https://github.com/example/skills.git",
        skill: "frontend-design",
        ref: "v1",
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      },
    ],
  };
  const lockfile = {
    version: 1 as const,
    skills: [
      {
        id: skillId("sk_01JB"),
        source: "https://github.com/example/skills.git",
        skill: "code-review",
        ref: "main",
        repository: "https://github.com/example/skills.git",
        revision: "abcdef1",
        path: "skills/code-review",
        contentHash: "sha256:review",
      },
      {
        id: skillId("sk_01JA"),
        source: "https://github.com/example/skills.git",
        skill: "frontend-design",
        ref: "v1",
        repository: "https://github.com/example/skills.git",
        revision: "abcdef2",
        path: "skills/frontend-design",
        contentHash: "sha256:frontend",
      },
    ],
  };

  test("canonicalizes equivalent inputs into byte-identical YAML and JSON", () => {
    const reversedManifest = {
      ...manifest,
      skills: [...manifest.skills].reverse(),
    };
    const reversedLockfile = {
      ...lockfile,
      skills: [...lockfile.skills].reverse(),
    };

    expect(serializeManifest(manifest)).toBe(
      serializeManifest(reversedManifest),
    );
    expect(serializeLockfile(lockfile)).toBe(
      serializeLockfile(reversedLockfile),
    );
    expect(serializeLockfile(lockfile)).not.toContain("timestamp");
    expect(parseManifest(serializeManifest(manifest))).toEqual(
      parseManifest(serializeManifest(reversedManifest)),
    );
    expect(parseLockfile(serializeLockfile(lockfile))).toEqual(
      parseLockfile(serializeLockfile(reversedLockfile)),
    );
  });

  test("rejects duplicate stable IDs and source + skill identities", () => {
    expect(() =>
      serializeManifest({
        ...manifest,
        skills: [
          ...manifest.skills,
          { ...manifest.skills[0], id: skillId("sk_01JA") },
        ],
      }),
    ).toThrow("duplicate skill ID");
    expect(() =>
      serializeLockfile({
        ...lockfile,
        skills: [
          ...lockfile.skills,
          {
            ...lockfile.skills[0],
            id: skillId("sk_01JC"),
            revision: "abcdef3",
          },
        ],
      }),
    ).toThrow("duplicate source + skill");
    expect(() =>
      parseLockfile(
        JSON.stringify({ ...lockfile, resolvedAt: "2026-01-01T00:00:00.000Z" }),
      ),
    ).toThrow("Invalid toolmirror.lock");
  });

  test("allows missing locks only for Cloud PENDING_RESOLUTION", () => {
    const pending = {
      version: 1 as const,
      skills: [
        {
          ...manifest.skills[0],
          resolutionStatus: "PENDING_RESOLUTION" as const,
        },
      ],
    };
    const emptyLockfile = { version: 1 as const, skills: [] };

    expect(
      validateDesiredState(
        { manifest: pending, lockfile: emptyLockfile },
        "cloud",
      ),
    ).toEqual({
      manifest: expect.objectContaining({
        skills: [expect.objectContaining({ id: "sk_01JB" })],
      }),
      lockfile: emptyLockfile,
    });
    expect(() =>
      validateDesiredState(
        { manifest: pending, lockfile: emptyLockfile },
        "git",
      ),
    ).toThrow("only Cloud PENDING_RESOLUTION");
    expect(() =>
      validateDesiredState(
        {
          manifest: {
            ...pending,
            skills: [
              { ...pending.skills[0], resolutionStatus: "RESOLVED" as const },
            ],
          },
          lockfile: emptyLockfile,
        },
        "cloud",
      ),
    ).toThrow("only Cloud PENDING_RESOLUTION");
  });
});
