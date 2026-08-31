import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId, type V2DesiredState } from "../../../packages/core/src/index";
import { gitTreeHash } from "../../../packages/git-provider/src/index";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { createCliV2GitStateProvider } from "./artifact-consent";
import type { CliIo } from "./cli";

const directories: string[] = [];
const id = skillId("sk_cliArtifact");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function repository(): Promise<
  Readonly<{ bare: string; worktree: string; artifact: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "corotum-cli-artifact-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  const bare = join(root, "remote.git");
  const artifact = join(root, "artifact");
  await git(["init", "--initial-branch=main", worktree]);
  await git(["-C", worktree, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", worktree, "config", "user.name", "Corotum tests"]);
  await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", bare]);
  await git(["-C", worktree, "remote", "add", "origin", bare]);
  await git(["-C", worktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await mkdir(artifact);
  await writeFile(join(artifact, "SKILL.md"), "# Local skill\n");
  return { bare, worktree, artifact };
}

function io(stdinIsTTY: boolean): CliIo {
  return {
    stdinIsTTY,
    writeError: () => undefined,
    writeOutput: () => undefined,
  };
}

async function artifactState(directory: string): Promise<V2DesiredState> {
  const artifact = {
    kind: "git-tree" as const,
    contentHash: (await scanNormalizedContent(directory)).contentHash,
    integrityHash: await gitTreeHash(directory),
  };
  return {
    manifest: {
      version: 2,
      skills: [
        {
          id,
          name: "local-skill",
          targets: "all",
          resolutionStatus: "RESOLVED",
        },
      ],
    },
    lockfile: {
      version: 2,
      skills: [
        {
          id,
          name: "local-skill",
          materialization: {
            kind: "artifact",
            artifact: {
              ...artifact,
              locator: `artifacts/${id}/${artifact.integrityHash.slice(7)}`,
              sizeBytes: 1,
            },
          },
        },
      ],
    },
  };
}

describe("CLI Git artifact consent", () => {
  test("prompts before an artifact mutation and refusal leaves every Git and local input unchanged", async () => {
    const fixture = await repository();
    const base = await git(["-C", fixture.worktree, "rev-parse", "HEAD"]);
    const prompts: string[] = [];
    const refused = createCliV2GitStateProvider({
      storagePath: join(fixture.worktree, "refused-cache"),
      source: fixture.bare,
      options: { allowArtifacts: false, nonInteractive: false },
      io: io(true),
      ask: async (question) => {
        prompts.push(question);
        return false;
      },
    });

    await expect(
      refused.push({
        state: await artifactState(fixture.artifact),
        ledger: { version: 2, activeDispositions: {} },
        baseRevision: base,
        artifacts: { [id]: fixture.artifact },
      }),
    ).rejects.toThrow("cancelled");
    expect(prompts).toEqual([
      expect.stringContaining(
        "Exact local skill content will be committed to your Git repository",
      ),
    ]);
    expect(await git(["-C", fixture.worktree, "rev-parse", "HEAD"])).toBe(base);
    expect(await readFile(join(fixture.artifact, "SKILL.md"), "utf8")).toBe(
      "# Local skill\n",
    );

    const accepted = createCliV2GitStateProvider({
      storagePath: join(fixture.worktree, "accepted-cache"),
      source: fixture.bare,
      options: { allowArtifacts: false, nonInteractive: false },
      io: io(true),
      ask: async () => true,
    });
    await accepted.push({
      state: await artifactState(fixture.artifact),
      ledger: { version: 2, activeDispositions: {} },
      baseRevision: base,
      artifacts: { [id]: fixture.artifact },
    });
    expect(
      await git(["--git-dir", fixture.bare, "rev-parse", "HEAD"]),
    ).not.toBe(base);
  });

  test("requires --allow-artifacts without a TTY and never invokes a prompt", async () => {
    const fixture = await repository();
    const base = await git(["-C", fixture.worktree, "rev-parse", "HEAD"]);
    const provider = createCliV2GitStateProvider({
      storagePath: join(fixture.worktree, "cache"),
      source: fixture.bare,
      options: { allowArtifacts: false, nonInteractive: false },
      io: io(false),
      ask: async () => {
        throw new Error("must not prompt");
      },
    });
    await expect(
      provider.push({
        state: await artifactState(fixture.artifact),
        ledger: { version: 2, activeDispositions: {} },
        baseRevision: base,
        artifacts: { [id]: fixture.artifact },
      }),
    ).rejects.toMatchObject({ name: "V2ArtifactConsentRequiredError" });
    expect(await git(["--git-dir", fixture.bare, "rev-parse", "HEAD"])).toBe(
      base,
    );

    const optedIn = createCliV2GitStateProvider({
      storagePath: join(fixture.worktree, "opted-in-cache"),
      source: fixture.bare,
      options: { allowArtifacts: true, nonInteractive: false },
      io: io(false),
      ask: async () => {
        throw new Error("must not prompt");
      },
    });
    await optedIn.push({
      state: await artifactState(fixture.artifact),
      ledger: { version: 2, activeDispositions: {} },
      baseRevision: base,
      artifacts: { [id]: fixture.artifact },
    });
  });

  test("does not request artifact consent for source-backed state", async () => {
    const fixture = await repository();
    const base = await git(["-C", fixture.worktree, "rev-parse", "HEAD"]);
    const hash = `sha256:${"a".repeat(64)}` as const;
    const source = {
      repository: "https://github.com/example/skills.git",
      path: "review",
      ref: "main",
    };
    const provider = createCliV2GitStateProvider({
      storagePath: join(fixture.worktree, "cache"),
      source: fixture.bare,
      options: { allowArtifacts: false, nonInteractive: false },
      io: io(true),
      ask: async () => {
        throw new Error("must not prompt");
      },
    });
    await provider.push({
      state: {
        manifest: {
          version: 2,
          skills: [
            {
              id,
              name: "review",
              targets: "all",
              source,
              resolutionStatus: "RESOLVED",
            },
          ],
        },
        lockfile: {
          version: 2,
          skills: [
            {
              id,
              name: "review",
              source: {
                ...source,
                revision: "a".repeat(40),
                contentHash: hash,
              },
              materialization: { kind: "source", contentHash: hash },
            },
          ],
        },
      },
      ledger: { version: 2, activeDispositions: {} },
      baseRevision: base,
    });
  });
});
