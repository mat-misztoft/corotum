import { describe, expect, test } from "bun:test";
import {
  type ActualState,
  aggregateTargetOutcomes,
  type DesiredStateEnvelope,
  type DomainErrorCode,
  mergeDesiredStates,
  offlineSkillDisposition,
  parseLockfile,
  parseManifest,
  parseRevisionTransition,
  planReconcile,
  type Result,
  revisionId,
  type SkillId,
  type StateProvider,
  serializeLockfile,
  serializeManifest,
  serializeRevisionTransition,
  skillId,
  validateDesiredState,
  parseDispositionLedger,
  parseV2Lockfile,
  parseV2Manifest,
  serializeDispositionLedger,
  serializeV2Lockfile,
  serializeV2Manifest,
  validateV2DesiredState,
} from "./index";

describe("v2 desired-state contracts", () => {
  const id = skillId("sk_01V2");
  const manifest = {
    version: 2 as const,
    skills: [{ id, name: "review", targets: "all" as const, source: { repository: "https://example.test/skills.git", path: "review", ref: "main" }, resolutionStatus: "RESOLVED" as const }],
  };
  const lockfile = {
    version: 2 as const,
    skills: [{ id, name: "review", source: { ...manifest.skills[0].source, revision: "a".repeat(40), contentHash: `sha256:${"a".repeat(64)}` as const }, materialization: { kind: "source" as const, contentHash: `sha256:${"a".repeat(64)}` as const } }],
  };

  test("round-trips byte-stably and preserves source nullability for artifact locks", () => {
    const artifactManifest = { ...manifest, skills: [{ ...manifest.skills[0], source: null }] };
    const artifactLock = { version: 2 as const, skills: [{ id, name: "review", materialization: { kind: "artifact" as const, artifact: { kind: "git-tree" as const, contentHash: `sha256:${"b".repeat(64)}` as const, integrityHash: `sha256:${"c".repeat(64)}` as const, locator: "artifacts/review", sizeBytes: 1 } } }] };
    expect(serializeV2Manifest(manifest)).toBe(serializeV2Manifest({ ...manifest, skills: [...manifest.skills].reverse() }));
    expect(serializeV2Lockfile(lockfile)).toBe(serializeV2Lockfile(lockfile));
    expect(validateV2DesiredState({ manifest: artifactManifest, lockfile: artifactLock }).lockfile.skills[0]?.materialization.kind).toBe("artifact");
    expect(parseV2Lockfile(serializeV2Lockfile(lockfile), parseV2Manifest(serializeV2Manifest(manifest)))).toEqual(lockfile);
  });

  test("rejects duplicate normalized names and incompatible materialization", () => {
    expect(() => parseV2Manifest(serializeV2Manifest({ ...manifest, skills: [...manifest.skills, { ...manifest.skills[0], id: skillId("sk_02V2"), name: "REVIEW" }] }))).toThrow("Invalid corotum.yaml manifest");
    expect(() => parseV2Manifest(serializeV2Manifest({ ...manifest, skills: [...manifest.skills, { ...manifest.skills[0], name: "other" }] }))).toThrow("Invalid corotum.yaml manifest");
    expect(() => validateV2DesiredState({ manifest, lockfile: { ...lockfile, skills: [{ ...lockfile.skills[0], materialization: { kind: "source", contentHash: `sha256:${"b".repeat(64)}` as const } }] } })).toThrow("must match its source hash");
    expect(() => validateV2DesiredState({ manifest, lockfile: { ...lockfile, skills: [{ ...lockfile.skills[0], source: { ...lockfile.skills[0].source, path: "different" } }] } })).toThrow("must match its manifest source");
    expect(() => validateV2DesiredState({ manifest, lockfile: { ...lockfile, skills: [{ ...lockfile.skills[0], materialization: { kind: "artifact", artifact: { kind: "git-tree", contentHash: `sha256:${"a".repeat(64)}` as const, integrityHash: `sha256:${"b".repeat(64)}` as const, locator: "artifacts/review", sizeBytes: 1 } } }] } })).toThrow("must not include a source lock");
  });

  test("rejects malformed IDs, hashes, and incomplete artifact descriptors", () => {
    expect(() => parseV2Manifest("version: 2\nskills:\n  - id: invalid\n    name: review\n    targets: all\n")).toThrow("Invalid corotum.yaml manifest");
    expect(() => parseV2Manifest("version: 2\nskills:\n  - id: sk_01V2\n    name: nested\\review\n    targets: all\n")).toThrow("Invalid corotum.yaml manifest");
    expect(() => parseV2Lockfile(JSON.stringify({ ...lockfile, skills: [{ ...lockfile.skills[0], source: { ...lockfile.skills[0].source, contentHash: "sha256:bad" } }] }), manifest)).toThrow("Invalid corotum.lock lockfile");
    expect(() => parseV2Lockfile(JSON.stringify({ ...lockfile, skills: [{ ...lockfile.skills[0], source: { ...lockfile.skills[0].source, revision: "HEAD" } }] }), manifest)).toThrow("Invalid corotum.lock lockfile");
    expect(() => parseV2Lockfile(JSON.stringify({ version: 2, skills: [{ id, name: "review", materialization: { kind: "artifact", artifact: { kind: "git-tree", contentHash: `sha256:${"a".repeat(64)}`, integrityHash: `sha256:${"b".repeat(64)}`, locator: "artifact" } } }] }), manifest)).toThrow("Invalid corotum.lock lockfile");
  });

  test("serializes a durable disposition ledger after unrelated revisions and re-add", () => {
    const ledger = { version: 2 as const, activeDispositions: { [id]: { skillId: id, name: "review", disposition: "UNMANAGE" as const, effectiveSequence: 2 } } };
    const serialized = serializeDispositionLedger(ledger);
    const afterUnrelatedRevision = parseDispositionLedger(serialized);
    expect(afterUnrelatedRevision).toEqual(ledger);
    expect(serializeDispositionLedger(afterUnrelatedRevision)).toBe(serialized);
    expect(validateV2DesiredState({ manifest, lockfile }).manifest.skills).toEqual([expect.objectContaining({ id, name: "review" })]);
    expect(afterUnrelatedRevision.activeDispositions[id]).toEqual(ledger.activeDispositions[id]);
  });

  test("publishes every v2 materialization failure code", () => {
    const codes: readonly DomainErrorCode[] = [
      "AUTH_REQUIRED",
      "SOURCE_UNAVAILABLE",
      "ARTIFACT_UNAVAILABLE",
      "CONTENT_HASH_MISMATCH",
      "LOCAL_CONFLICT",
      "DRIFTED",
      "NETWORK_ERROR",
    ];
    expect(codes).toHaveLength(7);
  });
});

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

describe("actual-state diff and reconcile planning", () => {
  const source = "https://github.com/example/skills.git";
  const synced = skillId("sk_01JSynced");
  const unmanaged = skillId("sk_01JUnmanaged");
  const missing = skillId("sk_01JMissing");
  const drifted = skillId("sk_01JDrifted");
  const pending = skillId("sk_01JPending");
  const removed = skillId("sk_01JRemoved");
  const unknown = skillId("sk_01JUnknown");
  const resolvedIds = [synced, unmanaged, missing, drifted];

  const desired = {
    manifest: {
      version: 1 as const,
      skills: [
        ...resolvedIds.map((id) => ({
          id,
          source,
          skill: id.slice(4).toLowerCase(),
          ref: "main",
          targets: "all" as const,
          resolutionStatus: "RESOLVED" as const,
        })),
        {
          id: pending,
          source,
          skill: "pending",
          ref: "main",
          targets: "all" as const,
          resolutionStatus: "PENDING_RESOLUTION" as const,
        },
      ],
    },
    lockfile: {
      version: 1 as const,
      skills: resolvedIds.map((id) => ({
        id,
        source,
        skill: id.slice(4).toLowerCase(),
        ref: "main",
        repository: source,
        revision: "abc123",
        path: `skills/${id.slice(4).toLowerCase()}`,
        contentHash: `sha256:${id}`,
      })),
    },
  };

  const actual: ActualState = {
    skills: {
      [synced]: { managed: true, contentHash: `sha256:${synced}` },
      [unmanaged]: { managed: false, contentHash: `sha256:${unmanaged}` },
      [drifted]: { managed: true, contentHash: "sha256:changed" },
      [removed]: { managed: true, contentHash: "sha256:old" },
      [unknown]: { managed: false, contentHash: "sha256:local" },
    },
  };

  test("classifies every local safety state and plans only safe sync operations", () => {
    const plan = planReconcile(desired, actual);

    expect(plan.classifications).toEqual(
      expect.arrayContaining([
        { skillId: synced, classification: "MANAGED_SYNCED" },
        { skillId: unmanaged, classification: "UNMANAGED" },
        { skillId: missing, classification: "MISSING" },
        { skillId: drifted, classification: "DRIFTED" },
        { skillId: pending, classification: "PENDING_RESOLUTION" },
        { skillId: removed, classification: "REMOVE_CANDIDATE" },
        { skillId: unknown, classification: "UNMANAGED" },
      ]),
    );
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "INSTALL",
        skill: expect.objectContaining({ id: missing }),
      }),
      { kind: "REMOVE", skillId: removed },
    ]);
    expect(
      plan.operations.some((operation) =>
        operation.kind === "INSTALL"
          ? operation.skill.id === unmanaged || operation.skill.id === drifted
          : operation.skillId === unmanaged || operation.skillId === drifted,
      ),
    ).toBeFalse();
  });

  test("returns a stable plan regardless of source collection order", () => {
    const reversed = {
      manifest: {
        ...desired.manifest,
        skills: [...desired.manifest.skills].reverse(),
      },
      lockfile: {
        ...desired.lockfile,
        skills: [...desired.lockfile.skills].reverse(),
      },
    };
    const reversedActual: ActualState = {
      skills: Object.fromEntries(
        Object.entries(actual.skills).reverse(),
      ) as ActualState["skills"],
    };

    expect(planReconcile(desired, actual)).toEqual(
      planReconcile(reversed, reversedActual),
    );
  });

  test("rejects a resolved skill without locked content", () => {
    expect(() =>
      planReconcile(
        {
          manifest: desired.manifest,
          lockfile: {
            ...desired.lockfile,
            skills: desired.lockfile.skills.filter(
              (skill) => skill.id !== missing,
            ),
          },
        },
        actual,
      ),
    ).toThrow(`Resolved skill ${missing} has no lock entry.`);
  });

  test("aggregates target outcomes safely", () => {
    expect(aggregateTargetOutcomes(["SUCCESS", "SUCCESS"])).toBe("SUCCESS");
    expect(aggregateTargetOutcomes(["SUCCESS", "AUTH_REQUIRED"])).toBe(
      "PARTIAL_SUCCESS",
    );
    expect(aggregateTargetOutcomes(["CONFLICT"])).toBe("CONFLICT");
    expect(aggregateTargetOutcomes(["AUTH_REQUIRED"])).toBe("AUTH_REQUIRED");
    expect(aggregateTargetOutcomes(["DEVICE_ERROR"])).toBe("DEVICE_ERROR");
    expect(aggregateTargetOutcomes(["CONFLICT", "DEVICE_ERROR"])).toBe(
      "PARTIAL_SUCCESS",
    );
  });
});

describe("offline transition safety contracts", () => {
  const source = "https://github.com/example/skills.git";
  const removed = skillId("sk_01JOfflineRemove");
  const unmanaged = skillId("sk_01JOfflineUnmanage");
  const readded = skillId("sk_01JOfflineReadd");

  const desired = (skills: readonly SkillId[]) => ({
    manifest: {
      version: 1 as const,
      skills: skills.map((id) => ({
        id,
        source,
        skill: id.slice(4).toLowerCase(),
        ref: "main",
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      })),
    },
    lockfile: {
      version: 1 as const,
      skills: skills.map((id) => ({
        id,
        source,
        skill: id.slice(4).toLowerCase(),
        ref: "main",
        repository: source,
        revision: "abc123",
        path: `skills/${id.slice(4).toLowerCase()}`,
        contentHash: `sha256:${id}:locked`,
      })),
    },
  });

  test("offline REMOVE deletes only assets with recorded managed ownership", () => {
    const plan = planReconcile(
      desired([]),
      {
        skills: {
          [removed]: { managed: true, contentHash: "sha256:locked" },
          [unmanaged]: { managed: false, contentHash: "sha256:local" },
        },
      },
      [{ type: "REMOVE", skillId: removed, metadata: {} }],
    );

    expect(plan.classifications).toEqual([
      { skillId: removed, classification: "REMOVE_CANDIDATE" },
      { skillId: unmanaged, classification: "UNMANAGED" },
    ]);
    expect(plan.operations).toEqual([{ kind: "REMOVE", skillId: removed }]);
  });

  test("offline UNMANAGE preserves local content by removing ownership, not content", () => {
    const plan = planReconcile(
      desired([]),
      {
        skills: { [unmanaged]: { managed: true, contentHash: "sha256:kept" } },
      },
      [{ type: "UNMANAGE", skillId: unmanaged, metadata: {} }],
    );

    expect(plan.classifications).toEqual([
      { skillId: unmanaged, classification: "UNMANAGE_CANDIDATE" },
    ]);
    expect(plan.operations).toEqual([{ kind: "UNMANAGE", skillId: unmanaged }]);
  });

  test("UNMANAGE followed by ADD does not overwrite changed unmanaged content", () => {
    const plan = planReconcile(
      desired([readded]),
      {
        skills: {
          [readded]: { managed: false, contentHash: "sha256:changed" },
        },
      },
      [
        { type: "UNMANAGE", skillId: readded, metadata: {} },
        { type: "ADD", skillId: readded, metadata: {} },
      ],
    );

    expect(plan.classifications).toEqual([
      { skillId: readded, classification: "UNMANAGED" },
    ]);
    expect(plan.operations).toEqual([]);
  });

  test("ordinary sync never overwrites a drifted managed skill", () => {
    const plan = planReconcile(desired([readded]), {
      skills: { [readded]: { managed: true, contentHash: "sha256:changed" } },
    });

    expect(plan.classifications).toEqual([
      { skillId: readded, classification: "DRIFTED" },
    ]);
    expect(plan.operations).toEqual([]);
  });
});

describe("revision transitions and domain merges", () => {
  const source = "https://github.com/example/skills.git";
  const managed = skillId("sk_01JManaged");
  const remoteOnly = skillId("sk_01JRemote");
  const localOnly = skillId("sk_01JLocal");

  const state = (skills: readonly { id: typeof managed; ref?: string }[]) => ({
    manifest: {
      version: 1 as const,
      skills: skills.map(({ id, ref = "main" }) => ({
        id,
        source,
        skill: id.slice(4).toLowerCase(),
        ref,
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      })),
    },
    lockfile: {
      version: 1 as const,
      skills: skills.map(({ id, ref = "main" }) => ({
        id,
        source,
        skill: id.slice(4).toLowerCase(),
        ref,
        repository: source,
        revision: `${id}-${ref}`,
        path: `skills/${id.slice(4).toLowerCase()}`,
        contentHash: `sha256:${id}-${ref}`,
      })),
    },
  });

  test("round-trips every transition with deterministic metadata", () => {
    const types = [
      "ADD",
      "REMOVE",
      "UNMANAGE",
      "UPDATE",
      "SET_REF",
      "ADOPT",
    ] as const;

    for (const type of types) {
      const transition = {
        type,
        skillId: managed,
        metadata: { after: "new", before: "old" },
      } as const;
      expect(
        parseRevisionTransition(serializeRevisionTransition(transition)),
      ).toEqual(transition);
    }
  });

  test("treats a later add as managed when an offline device returns", () => {
    const transitions = [
      { type: "UNMANAGE" as const, skillId: managed, metadata: {} },
      {
        type: "ADD" as const,
        skillId: managed,
        metadata: { source: "restore" },
      },
    ];

    expect(
      offlineSkillDisposition(state([{ id: managed }]), transitions, managed),
    ).toBe("MANAGED");
    expect(offlineSkillDisposition(state([]), transitions, managed)).toBe(
      "UNMANAGE",
    );
  });

  test("merges independent changes and reports incompatible same-skill changes", () => {
    const base = state([{ id: managed }]);
    const merged = mergeDesiredStates(
      base,
      state([{ id: managed }, { id: remoteOnly }]),
      state([{ id: managed }, { id: localOnly }]),
      "git",
    );

    expect(merged).toEqual({
      kind: "merged",
      state: expect.objectContaining({
        manifest: expect.objectContaining({
          skills: expect.arrayContaining([
            expect.objectContaining({ id: managed }),
            expect.objectContaining({ id: remoteOnly }),
            expect.objectContaining({ id: localOnly }),
          ]),
        }),
      }),
    });
    expect(
      mergeDesiredStates(
        base,
        state([{ id: managed, ref: "remote" }]),
        state([{ id: managed, ref: "local" }]),
        "git",
      ),
    ).toEqual({
      kind: "conflict",
      conflicts: [
        expect.objectContaining({
          skillId: managed,
          base: expect.objectContaining({ ref: "main" }),
          remote: expect.objectContaining({ ref: "remote" }),
          local: expect.objectContaining({ ref: "local" }),
        }),
      ],
    });
  });
});
