import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptArtifactChoices,
  decideInitAdoptions,
  SOURCE_REFRESH_NOTICE,
} from "./init-adoption";
import { discoverInitProvenance } from "./init-provenance";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gitRepo(content = "# review\n"): Promise<{ directory: string; revision: string }> {
  const directory = await mkdtemp(join(tmpdir(), "corotum-init-git-"));
  roots.push(directory);
  await git(["init", "--initial-branch=main", directory]);
  await git(["-C", directory, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", directory, "config", "user.name", "Corotum tests"]);
  await mkdir(join(directory, "skills", "review"), { recursive: true });
  await writeFile(join(directory, "skills", "review", "SKILL.md"), content);
  await git(["-C", directory, "add", "."]);
  await git(["-C", directory, "commit", "-m", "fixture"]);
  return { directory, revision: (await git(["-C", directory, "rev-parse", "HEAD"])).trim() };
}

async function home(input: {
  git: string;
  content?: string;
  lock?: unknown;
  names?: readonly string[];
  extra?: Readonly<Record<string, string>>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corotum-init-home-"));
  roots.push(root);
  const skills = join(root, ".agents", "skills");
  await mkdir(skills, { recursive: true });
  for (const name of input.names ?? ["review"]) {
    await mkdir(join(skills, name));
    await writeFile(join(skills, name, "SKILL.md"), input.content ?? "# review\n");
    if (input.extra) {
      for (const [file, body] of Object.entries(input.extra)) {
        await writeFile(join(skills, name, file), body);
      }
    }
  }
  const lock = input.lock === undefined
    ? {
      skills: {
        review: {
          source: "skills.sh",
          sourceType: "github",
          sourceUrl: input.git,
          skillPath: "skills/review",
          skillFolderHash: "sha256:recorded",
        },
      },
    }
    : input.lock;
  if (lock !== null) await writeFile(join(root, ".agents", ".skill-lock.json"), JSON.stringify(lock));
  return root;
}

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

async function snapshot(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("init adoption decisions", () => {
  test("locks known unchanged content to the resolved immutable revision, not HEAD", async () => {
    const source = await gitRepo();
    const root = await home({ git: source.directory });
    const skill = join(root, ".agents", "skills", "review", "SKILL.md");
    const before = await snapshot(skill);
    const notices: string[] = [];
    const [outcome] = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: false,
      prompt: interactive({ notice: (message) => notices.push(message) }),
    });
    expect(outcome).toMatchObject({
      kind: "source-backed",
      classification: "unchanged",
      notice: SOURCE_REFRESH_NOTICE,
      source: {
        ref: "main",
        revision: source.revision,
        path: "skills/review",
      },
      materialization: { kind: "source" },
    });
    expect(outcome.kind === "source-backed" && outcome.source.revision).not.toBe("HEAD");
    expect(notices).toEqual([SOURCE_REFRESH_NOTICE]);
    expect(await snapshot(skill)).toBe(before);
  });

  test("modified Replace/Keep/Do-not-manage follow the documented per-skill outcomes", async () => {
    const source = await gitRepo();
    const replaceHome = await home({ git: source.directory, content: "# local\n" });
    const keepHome = await home({ git: source.directory, content: "# local\n" });
    const skipHome = await home({ git: source.directory, content: "# local\n" });
    const before = await snapshot(join(skipHome, ".agents", "skills", "review", "SKILL.md"));

    const replaced = await decideInitAdoptions({
      candidates: await discoverInitProvenance(replaceHome),
      nonInteractive: false,
      prompt: interactive({ chooseModified: async () => "replace" }),
    });
    const kept = await decideInitAdoptions({
      candidates: await discoverInitProvenance(keepHome),
      nonInteractive: false,
      prompt: interactive({ chooseModified: async () => "keep" }),
    });
    const skipped = await decideInitAdoptions({
      candidates: await discoverInitProvenance(skipHome),
      nonInteractive: false,
      prompt: interactive({ chooseModified: async () => "do-not-manage" }),
    });

    expect(replaced[0]).toMatchObject({
      kind: "source-backed",
      classification: "modified",
      source: { revision: source.revision, ref: "main" },
    });
    expect(kept[0]).toMatchObject({
      kind: "artifact-backed",
      classification: "modified",
      source: { repository: source.directory, path: "skills/review", ref: "main" },
    });
    expect(skipped[0]).toMatchObject({ kind: "unmanaged", outcome: "DO_NOT_MANAGE", classification: "modified" });
    expect(await snapshot(join(skipHome, ".agents", "skills", "review", "SKILL.md"))).toBe(before);
  });

  test("unavailable Keep retains known source metadata and never overwrites local content", async () => {
    const source = await gitRepo();
    const missing = join(source.directory, "gone.git");
    const root = await home({
      git: missing,
    });
    const skill = join(root, ".agents", "skills", "review", "SKILL.md");
    const before = await snapshot(skill);
    const kept = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: false,
      prompt: interactive({ chooseUnavailable: async () => "keep" }),
    });
    expect(kept[0]).toMatchObject({
      kind: "artifact-backed",
      classification: "unavailable",
      outcome: "SOURCE_UNAVAILABLE",
      source: { repository: missing, path: "skills/review" },
    });
    expect(await snapshot(skill)).toBe(before);
  });

  test("unknown artifact adoption scans first and invents no source", async () => {
    const source = await gitRepo();
    const root = await home({ git: source.directory, lock: null });
    const [outcome] = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: adoptArtifactChoices(["review"]),
    });
    expect(outcome).toMatchObject({
      kind: "artifact-backed",
      classification: "unknown",
      localContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(outcome.kind === "artifact-backed" ? outcome.source : "missing").toBeUndefined();
  });

  test("denylisted local content cannot be selected as an artifact", async () => {
    const source = await gitRepo();
    const root = await home({ git: source.directory, lock: null, extra: { ".env": "SECRET=1\n" } });
    const [outcome] = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: adoptArtifactChoices(["review"]),
    });
    expect(outcome).toMatchObject({ kind: "unmanaged", outcome: "SCAN_FAILED", classification: "unknown" });
  });

  test("private AUTH_REQUIRED is distinct from unavailable and leaves local files untouched", async () => {
    const source = await gitRepo();
    const root = await home({ git: "https://example.com/private.git" });
    const skill = join(root, ".agents", "skills", "review", "SKILL.md");
    const before = await snapshot(skill);
    const [outcome] = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      runGit: async () => ({
        exitCode: 128,
        stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
        stdout: new Uint8Array(),
      }),
    });
    expect(outcome).toMatchObject({
      kind: "unmanaged",
      classification: "auth-required",
      outcome: "AUTH_REQUIRED",
    });
    expect(await snapshot(skill)).toBe(before);
  });

  test("duplicate normalized names require one explicit candidate", async () => {
    const source = await gitRepo();
    const root = await home({ git: source.directory, names: ["review", "review "], lock: null });
    const both = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: adoptArtifactChoices(["review", "review "]),
    });
    expect(both).toEqual([
      expect.objectContaining({ kind: "unmanaged", name: "review", outcome: "DUPLICATE_NAME" }),
      expect.objectContaining({ kind: "unmanaged", name: "review ", outcome: "DUPLICATE_NAME" }),
    ]);
    const selected = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: adoptArtifactChoices(["review"]),
    });
    expect(selected).toEqual([
      expect.objectContaining({ kind: "artifact-backed", name: "review" }),
      expect.objectContaining({ kind: "unmanaged", name: "review ", outcome: "DUPLICATE_NAME" }),
    ]);
  });

  test("non-interactive mode applies only exact supplied choices", async () => {
    const source = await gitRepo();
    const root = await home({ git: source.directory, names: ["review", "notes"], lock: {
      skills: {
        review: {
          source: "skills.sh",
          sourceType: "github",
          sourceUrl: source.directory,
          skillPath: "skills/review",
          skillFolderHash: "sha256:recorded",
        },
      },
    } });
    const outcomes = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: [{ name: "review", action: "replace" }],
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "unmanaged", name: "notes", outcome: "UNSELECTED", classification: "unknown" }),
      expect.objectContaining({ kind: "source-backed", name: "review", classification: "unchanged" }),
    ]);
    const invalid = await decideInitAdoptions({
      candidates: await discoverInitProvenance(root),
      nonInteractive: true,
      choices: adoptArtifactChoices(["review"]),
    });
    expect(invalid.find((outcome) => outcome.name === "review")).toMatchObject({
      kind: "unmanaged",
      outcome: "INVALID_CHOICE",
    });
  });
});

function interactive(overrides: Partial<{
  notice: (message: string) => void;
  chooseModified: () => Promise<"replace" | "keep" | "do-not-manage">;
  chooseUnavailable: () => Promise<"keep" | "do-not-manage">;
  chooseUnknown: () => Promise<"adopt-artifact" | "do-not-manage">;
  chooseDuplicate: () => Promise<string | "do-not-manage">;
}> = {}) {
  return {
    notice: overrides.notice ?? (() => undefined),
    chooseModified: overrides.chooseModified ?? (async () => "do-not-manage" as const),
    chooseUnavailable: overrides.chooseUnavailable ?? (async () => "do-not-manage" as const),
    chooseUnknown: overrides.chooseUnknown ?? (async () => "do-not-manage" as const),
    chooseDuplicate: overrides.chooseDuplicate ?? (async () => "do-not-manage" as const),
  };
}
