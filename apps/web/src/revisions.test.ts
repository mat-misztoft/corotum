import { expect, test } from "bun:test";
import { type DesiredState, skillId } from "../../../packages/core/src/index";
import { mutateDesiredState, RevisionConflictError } from "./revisions";

const skill = skillId("sk_01JCloudRevision");
const source = "https://github.com/example/skills.git";
const state = (name = "review"): DesiredState => ({
  manifest: {
    version: 1,
    skills: [
      {
        id: skill,
        source,
        skill: name,
        ref: "main",
        targets: "all",
        resolutionStatus: "RESOLVED",
      },
    ],
  },
  lockfile: {
    version: 1,
    skills: [
      {
        id: skill,
        source,
        skill: name,
        ref: "main",
        repository: source,
        revision: "abc123",
        path: `skills/${name}`,
        contentHash: "sha256:locked",
      },
    ],
  },
});

type Memory = {
  sequence: number;
  revisionId: string | null;
  snapshots: { id: string; state: DesiredState }[];
  skills: string[];
  idempotency: Map<string, string>;
};

function database(memory: Memory) {
  const statement = (query: string, values: unknown[] = []) => ({
    query,
    values,
    bind(...next: unknown[]) {
      return statement(query, next);
    },
    async first<T>() {
      if (query.includes("idempotency_records")) {
        const result = memory.idempotency.get(values[0] as string);
        return (result ? { responseJson: result } : null) as T | null;
      }
      if (query.includes("current_revision_sequence"))
        return { currentRevisionSequence: memory.sequence } as T;
      if (query.includes("FROM workspaces"))
        return { id: "ws_1", ownerUserId: "user_1", name: "My workspace" } as T;
      return null;
    },
    async run() {
      return {};
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });

  return {
    prepare(query: string) {
      return statement(query);
    },
    async batch(statements: readonly ReturnType<typeof statement>[]) {
      const idempotency = statements[0].values[0] as string;
      if (memory.idempotency.has(idempotency)) throw new Error("UNIQUE");
      const revision = statements[1];
      const suppliedBase = revision.values.at(-1) as string | undefined;
      const matches = memory.revisionId
        ? suppliedBase === memory.revisionId
        : memory.sequence === 0;
      if (!matches) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];

      const id = revision.values[0] as string;
      const nextState = {
        manifest: JSON.parse(revision.values[1] as string),
        lockfile: JSON.parse(revision.values[2] as string),
      } as DesiredState;
      memory.idempotency.set(idempotency, statements[0].values[3] as string);
      memory.sequence += 1;
      memory.revisionId = id;
      memory.snapshots.push({ id, state: nextState });
      memory.skills = nextState.manifest.skills.map(
        (candidate) => candidate.id,
      );
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
}

function mutation(
  baseRevisionId: string | null,
  idempotencyKey: string,
  next = state(),
) {
  return {
    workspaceId: "ws_1",
    userId: "user_1",
    baseRevisionId,
    idempotencyKey,
    actor: { type: "user" as const, id: "user_1" },
    state: next,
    transition: { type: "ADD" as const, skillId: skill, metadata: {} },
  };
}

test("accepted mutation retains an authoritative snapshot and materialized skill atomically", async () => {
  const memory: Memory = {
    sequence: 0,
    revisionId: null,
    snapshots: [],
    skills: [],
    idempotency: new Map(),
  };
  const revision = await mutateDesiredState(
    database(memory) as never,
    mutation(null, "key-1"),
  );
  expect(revision.sequence).toBe(1);
  expect(memory.snapshots).toEqual([{ id: revision.id, state: state() }]);
  expect(memory.skills).toEqual([skill]);
  expect(memory.sequence).toBe(1);
});

test("stale base creates neither a revision nor materialized changes", async () => {
  const memory: Memory = {
    sequence: 1,
    revisionId: "rev_current",
    snapshots: [],
    skills: ["sk_existing"],
    idempotency: new Map(),
  };
  await expect(
    mutateDesiredState(
      database(memory) as never,
      mutation("rev_stale", "key-stale"),
    ),
  ).rejects.toBeInstanceOf(RevisionConflictError);
  expect(memory).toMatchObject({
    sequence: 1,
    revisionId: "rev_current",
    snapshots: [],
    skills: ["sk_existing"],
  });
  expect(memory.idempotency.size).toBe(0);
});

test("idempotency retries return the original revision without another write", async () => {
  const memory: Memory = {
    sequence: 0,
    revisionId: null,
    snapshots: [],
    skills: [],
    idempotency: new Map(),
  };
  const db = database(memory) as never;
  const first = await mutateDesiredState(db, mutation(null, "key-repeat"));
  const retry = await mutateDesiredState(db, mutation(null, "key-repeat"));
  expect(retry).toEqual(first);
  expect(memory.snapshots).toHaveLength(1);
});
