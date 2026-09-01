import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DispositionLedger,
  skillId,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import { gitTreeHash, V2GitStateProvider } from "../../../packages/git-provider/src/index";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { SOURCE_REFRESH_NOTICE, type InitSkillOutcome } from "./init-adoption";
import {
  InitRecoveryStore,
  InitTransactionService,
  type InitV2Provider,
} from "./init-transaction";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}` as const;
const revision = "a".repeat(40);
const empty: V2DesiredState = { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } };
const emptyLedger: DispositionLedger = { version: 2, activeDispositions: {} };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sourceOutcome(name: string, path: string): InitSkillOutcome {
  return {
    kind: "source-backed",
    name,
    path,
    classification: "unchanged",
    source: {
      repository: "https://example.test/skills.git",
      path: name,
      ref: "main",
      revision,
      contentHash: hash,
    },
    materialization: { kind: "source", contentHash: hash },
    notice: SOURCE_REFRESH_NOTICE,
  };
}

function unmanaged(name: string, path: string): InitSkillOutcome {
  return {
    kind: "unmanaged",
    name,
    path,
    classification: "unknown",
    outcome: "UNSELECTED",
    reason: "No exact non-interactive choice was supplied.",
  };
}

function memoryProvider(options?: {
  failPush?: boolean;
  existing?: V2DesiredState;
}): InitV2Provider & { pushes: number; last?: Parameters<InitV2Provider["push"]>[0] } {
  let state = options?.existing ?? empty;
  let ledger: DispositionLedger = emptyLedger;
  let revisionId: string | null = options?.existing ? "base" : "empty";
  const provider: InitV2Provider & { pushes: number; last?: Parameters<InitV2Provider["push"]>[0] } = {
    pushes: 0,
    pull: async () => ({ revisionId, state, ledger }),
    push: async (input) => {
      if (options?.failPush) throw new Error("desired-state push failed");
      provider.pushes += 1;
      provider.last = input;
      state = input.state;
      ledger = input.ledger;
      revisionId = "next";
      return { revisionId, state, ledger };
    },
  };
  return provider;
}

describe("init transaction", () => {
  test("records every adopted ID in the batch audit transition", async () => {
    const root = await tempDir("corotum-init-batch-");
    const provider = memoryProvider();
    const applied: string[] = [];
    const service = new InitTransactionService({
      provider,
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "git" },
      createSkillId: (() => {
        let n = 0;
        return () => skillId(`sk_init${n++}`);
      })(),
      apply: async (input) => {
        applied.push(...input.skills.map((skill) => skill.id));
      },
    });
    const result = await service.run({
      outcomes: [sourceOutcome("alpha", "/tmp/alpha"), sourceOutcome("beta", "/tmp/beta"), unmanaged("gamma", "/tmp/gamma")],
    });
    expect(result.kind).toBe("initialized");
    expect(provider.pushes).toBe(1);
    expect(provider.last?.ledger.audit?.map((entry) => entry.skillId)).toEqual(["sk_init0", "sk_init1"]);
    expect(provider.last?.ledger.audit?.every((entry) => entry.type === "ADOPT")).toBe(true);
    expect(provider.last?.state.manifest.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(applied).toEqual(["sk_init0", "sk_init1"]);
    expect(result.kind === "initialized" && result.outcomes.some((outcome) => outcome.name === "gamma" && outcome.kind === "unmanaged")).toBe(true);
  });

  test("a desired-state push failure does not install or claim local ownership", async () => {
    const root = await tempDir("corotum-init-pushfail-");
    const unselected = join(root, "unselected");
    await mkdir(unselected, { recursive: true });
    await writeFile(join(unselected, "SKILL.md"), "leave me\n");
    const service = new InitTransactionService({
      provider: memoryProvider({ failPush: true }),
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "git" },
      apply: async () => {
        throw new Error("apply should not run");
      },
    });
    const result = await service.run({
      outcomes: [sourceOutcome("alpha", "/tmp/alpha"), unmanaged("gamma", unselected)],
    });
    expect(result).toMatchObject({ kind: "refused", reason: "desired-state push failed" });
    expect(await readFile(join(unselected, "SKILL.md"), "utf8")).toBe("leave me\n");
  });

  test("a local install failure after persist is retryable without duplicate IDs", async () => {
    const root = await tempDir("corotum-init-localfail-");
    const provider = memoryProvider();
    let applyAttempts = 0;
    const service = new InitTransactionService({
      provider,
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "git" },
      createSkillId: () => skillId("sk_retry1"),
      apply: async () => {
        applyAttempts += 1;
        if (applyAttempts === 1) throw new Error("disk full");
      },
    });
    const outcomes = [sourceOutcome("alpha", "/tmp/alpha")];
    const first = await service.run({ outcomes });
    expect(first).toMatchObject({ kind: "partial", phase: "desired-persisted", skillIds: ["sk_retry1"] });
    expect(provider.pushes).toBe(1);
    const retry = await service.run({ outcomes });
    expect(retry.kind).toBe("initialized");
    expect(provider.pushes).toBe(1);
    expect(retry.kind === "initialized" && retry.skillIds).toEqual(["sk_retry1"]);
  });

  test("a config failure after local verification retries config only", async () => {
    const root = await tempDir("corotum-init-configfail-");
    const provider = memoryProvider();
    let configs = 0;
    let applies = 0;
    const service = new InitTransactionService({
      provider,
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => {
        configs += 1;
        if (configs === 1) throw new Error("config write failed");
      },
      backend: { kind: "cloud", workspaceId: "ws_1" },
      createSkillId: () => skillId("sk_cfg1"),
      apply: async () => {
        applies += 1;
      },
    });
    const outcomes = [sourceOutcome("alpha", "/tmp/alpha")];
    expect(await service.run({ outcomes })).toMatchObject({
      kind: "partial",
      phase: "locally-verified",
    });
    expect(await service.run({ outcomes })).toMatchObject({ kind: "initialized", skillIds: ["sk_cfg1"] });
    expect(provider.pushes).toBe(1);
    expect(applies).toBe(1);
    expect(configs).toBe(2);
  });
});

describe("Git init artifacts and consent", () => {
  async function gitRemote(): Promise<string> {
    const root = await tempDir("corotum-init-git-");
    const worktree = join(root, "worktree");
    const bare = join(root, "remote.git");
    await git(["init", "--initial-branch=main", worktree]);
    await git(["-C", worktree, "config", "user.email", "tests@corotum.invalid"]);
    await git(["-C", worktree, "config", "user.name", "Corotum tests"]);
    await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
    await git(["init", "--bare", bare]);
    await git(["-C", worktree, "remote", "add", "origin", bare]);
    await git(["-C", worktree, "push", "-u", "origin", "main"]);
    return bare;
  }

  test("commits multi-skill Git artifacts only after consent and leaves unselected files", async () => {
    const root = await tempDir("corotum-init-consent-");
    const skill = join(root, "keep-me");
    const leftover = join(root, "leave-me");
    await mkdir(skill, { recursive: true });
    await mkdir(leftover, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "keep exact\n");
    await writeFile(join(leftover, "SKILL.md"), "unmanaged\n");
    const scanned = await scanNormalizedContent(skill);
    const integrity = await gitTreeHash(skill);
    const bare = await gitRemote();
    let prompted = 0;
    const gitProvider = new V2GitStateProvider(join(root, "cache"), bare, undefined, async (changes) => {
      prompted += 1;
      expect(changes.length).toBe(1);
    });
    const service = new InitTransactionService({
      provider: {
        pull: () => gitProvider.pullAllowEmpty(),
        push: (input) => gitProvider.push(input),
      },
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "git" },
      createSkillId: () => skillId("sk_art1"),
      apply: async () => undefined,
    });
    const result = await service.run({
      outcomes: [
        {
          kind: "artifact-backed",
          name: "keep-me",
          path: skill,
          classification: "unknown",
          localContentHash: scanned.contentHash,
        },
        unmanaged("leave-me", leftover),
      ],
    });
    expect(result.kind).toBe("initialized");
    expect(prompted).toBe(1);
    expect(await readFile(join(leftover, "SKILL.md"), "utf8")).toBe("unmanaged\n");
    const pulled = await gitProvider.pull();
    expect(pulled.ledger.audit?.map((entry) => entry.skillId)).toEqual(["sk_art1"]);
    expect(pulled.state.lockfile.skills[0]?.materialization).toMatchObject({
      kind: "artifact",
      artifact: { kind: "git-tree", contentHash: scanned.contentHash, integrityHash: integrity },
    });
  });

  test("source-backed Git init does not request artifact consent", async () => {
    const root = await tempDir("corotum-init-source-");
    const bare = await gitRemote();
    let prompted = 0;
    const gitProvider = new V2GitStateProvider(join(root, "cache"), bare, undefined, async () => {
      prompted += 1;
    });
    const service = new InitTransactionService({
      provider: {
        pull: () => gitProvider.pullAllowEmpty(),
        push: (input) => gitProvider.push(input),
      },
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "git" },
      createSkillId: () => skillId("sk_src1"),
      apply: async () => undefined,
    });
    expect(await service.run({ outcomes: [sourceOutcome("alpha", join(root, "alpha"))] })).toMatchObject({
      kind: "initialized",
    });
    expect(prompted).toBe(0);
  });
});

describe("Cloud init transaction", () => {
  test("persists Cloud artifacts without Git consent and records every ID", async () => {
    const root = await tempDir("corotum-init-cloud-");
    const skill = join(root, "local");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "cloud exact\n");
    const scanned = await scanNormalizedContent(skill);
    const uploads: string[] = [];
    const service = new InitTransactionService({
      provider: {
        pull: async () => ({ revisionId: null, state: empty, ledger: emptyLedger }),
        push: async (input) => {
          uploads.push(...Object.keys(input.artifacts));
          expect(input.ledger.audit?.map((entry) => entry.skillId).sort()).toEqual(["sk_c0", "sk_c1"]);
          expect(input.state.lockfile.skills.every((lock) =>
            lock.materialization.kind === "source" || lock.materialization.artifact.kind === "r2-tar-zst",
          )).toBe(true);
          return { revisionId: "cloud-1", state: input.state, ledger: input.ledger };
        },
      },
      recovery: new InitRecoveryStore(join(root, "init.json")),
      persistConfig: async () => undefined,
      backend: { kind: "cloud", workspaceId: "ws_1" },
      createSkillId: (() => {
        let n = 0;
        return () => skillId(`sk_c${n++}`);
      })(),
      apply: async () => undefined,
    });
    const result = await service.run({
      outcomes: [
        sourceOutcome("alpha", join(root, "alpha")),
        {
          kind: "artifact-backed",
          name: "local",
          path: skill,
          classification: "unknown",
          localContentHash: scanned.contentHash,
        },
      ],
    });
    expect(result).toMatchObject({ kind: "initialized", revision: "cloud-1" });
    expect(uploads).toEqual(["sk_c1"]);
  });
});

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
