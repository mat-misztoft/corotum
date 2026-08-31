import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LockedSkill, skillId } from "../../core/src/index";
import {
  assertSafeGitSource,
  type GitCommandRunner,
  GitSkillMaterializer,
  GitSourceError,
  normalizeGitSource,
} from "./git-source";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(): Promise<{
  branch: string;
  commit: string;
  directory: string;
  tag: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "corotum-source-fixture-"));
  temporaryDirectories.push(directory);
  await git(["init", "--initial-branch=main", directory]);
  await git([
    "-C",
    directory,
    "config",
    "user.email",
    "tests@corotum.invalid",
  ]);
  await git(["-C", directory, "config", "user.name", "Corotum tests"]);
  await mkdir(join(directory, "skills", "example"), { recursive: true });
  await writeFile(
    join(directory, "skills", "example", "SKILL.md"),
    "# Example\n",
  );
  await git(["-C", directory, "add", "."]);
  await git(["-C", directory, "commit", "-m", "fixture"]);
  const commit = (await git(["-C", directory, "rev-parse", "HEAD"])).trim();
  await git(["-C", directory, "tag", "v1"]);
  return { branch: "main", commit, directory, tag: "v1" };
}

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

describe("GitSkillMaterializer", () => {
  test("resolves branch, tag, and commit to identical immutable content", async () => {
    const source = await fixture();
    const materializer = new GitSkillMaterializer();
    const inputs = [source.branch, source.tag, source.commit].map((ref) => ({
      id: skillId("sk_source"),
      source: source.directory,
      skill: "example",
      ref,
      path: "skills/example",
    }));

    const results = await Promise.all(
      inputs.map((input) => materializer.resolve(input)),
    );
    expect(results.map((result) => result.repository)).toEqual([
      source.directory,
      source.directory,
      source.directory,
    ]);
    expect(results.map((result) => result.revision)).toEqual([
      source.commit,
      source.commit,
      source.commit,
    ]);
    expect(new Set(results.map((result) => result.contentHash)).size).toBe(1);
    expect(results[0]?.path).toBe("skills/example");
  });

  test("discovers each skill directory from a multi-skill source", async () => {
    const source = await fixture();
    await mkdir(join(source.directory, "skills", "second"), {
      recursive: true,
    });
    await writeFile(
      join(source.directory, "skills", "second", "SKILL.md"),
      "# Second\n",
    );
    await git(["-C", source.directory, "add", "."]);
    await git(["-C", source.directory, "commit", "-m", "second skill"]);
    expect(
      await new GitSkillMaterializer().discover(source.directory, "main"),
    ).toEqual([
      { name: "example", path: "skills/example" },
      { name: "second", path: "skills/second" },
    ]);
  });

  test("materializes only content matching the locked hash", async () => {
    const source = await fixture();
    const materializer = new GitSkillMaterializer();
    const resolved = await materializer.resolve({
      id: skillId("sk_source"),
      source: source.directory,
      skill: "example",
      ref: source.commit,
      path: "skills/example",
    });
    const destination = join(source.directory, "materialized");
    const lock: LockedSkill = {
      id: skillId("sk_source"),
      source: source.directory,
      skill: "example",
      ref: source.commit,
      ...resolved,
    };

    await materializer.materialize(lock, destination);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(
      "# Example\n",
    );

    await expect(
      materializer.materialize(
        { ...lock, contentHash: "sha256:wrong" },
        destination,
      ),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
  });

  test("rejects credential-bearing URLs before invoking Git", async () => {
    let invoked = false;
    const runner: GitCommandRunner = async () => {
      invoked = true;
      return { exitCode: 0, stderr: "", stdout: new Uint8Array() };
    };
    const materializer = new GitSkillMaterializer(runner);

    expect(() =>
      assertSafeGitSource("https://token@example.com/skills.git"),
    ).toThrow(GitSourceError);
    await expect(
      materializer.resolve({
        id: skillId("sk_source"),
        source: "https://token@example.com/skills.git",
        skill: "example",
        ref: "main",
      }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_IN_URL" });
    expect(invoked).toBeFalse();
  });

  test("expands GitHub shorthand without changing regular Git sources", () => {
    expect(normalizeGitSource("owner/repository")).toBe(
      "https://github.com/owner/repository.git",
    );
    expect(normalizeGitSource("git@github.com:owner/repository.git")).toBe(
      "git@github.com:owner/repository.git",
    );
  });

  test("reports inaccessible private repositories as AUTH_REQUIRED", async () => {
    const runner: GitCommandRunner = async () => ({
      exitCode: 128,
      stderr:
        "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      stdout: new Uint8Array(),
    });
    const materializer = new GitSkillMaterializer(runner);

    await expect(
      materializer.resolve({
        id: skillId("sk_private"),
        source: "https://example.com/private.git",
        skill: "private",
        ref: "main",
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
