import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V2LockedSkill, skillId } from "../../core/src/index";
import { createArtifactArchive } from "./artifact-archive";
import { CanonicalStoreError } from "./canonical-store";
import { ExactContentMaterializer, mapMaterializationError } from "./exact-materializer";
import { GitSkillMaterializer, GitSourceError } from "./git-source";
import { scanNormalizedContent } from "./normalized-content";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });

async function sourceFixture(): Promise<{ root: string; revision: string; contentHash: `sha256:${string}` }> {
  const root = await mkdtemp(join(tmpdir(), "corotum-exact-source-")); directories.push(root);
  await git(["init", "--initial-branch=main", root]);
  await git(["-C", root, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", root, "config", "user.name", "Corotum tests"]);
  await mkdir(join(root, "skill"));
  await Bun.write(join(root, "skill", "SKILL.md"), "# Pinned\n");
  await git(["-C", root, "add", "."]); await git(["-C", root, "commit", "-m", "pinned"]);
  return { root, revision: (await git(["-C", root, "rev-parse", "HEAD"])).trim(), contentHash: (await scanNormalizedContent(join(root, "skill"))).contentHash };
}
function sourceLock(fixture: Awaited<ReturnType<typeof sourceFixture>>): V2LockedSkill {
  return { id: skillId("sk_exact"), name: "exact", source: { repository: fixture.root, path: "skill", ref: "main", revision: fixture.revision, contentHash: fixture.contentHash }, materialization: { kind: "source", contentHash: fixture.contentHash } };
}
async function git(args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stderr); return stdout;
}

describe("ExactContentMaterializer", () => {
  test("stages the locked Git revision after upstream HEAD changes", async () => {
    const fixture = await sourceFixture();
    await writeFile(join(fixture.root, "skill", "SKILL.md"), "# New HEAD\n");
    await git(["-C", fixture.root, "add", "."]); await git(["-C", fixture.root, "commit", "-m", "head moved"]);
    const staged = await new ExactContentMaterializer().stage(sourceLock(fixture));
    try { expect(await readFile(join(staged.directory, "SKILL.md"), "utf8")).toBe("# Pinned\n"); }
    finally { await staged.cleanup(); }
  });

  test("stages git-tree artifacts from a directory without contacting upstream", async () => {
    const input = await mkdtemp(join(tmpdir(), "corotum-exact-gittree-")); directories.push(input);
    await writeFile(join(input, "SKILL.md"), "# Git tree\n");
    const contentHash = (await scanNormalizedContent(input)).contentHash;
    const lock: V2LockedSkill = {
      id: skillId("sk_tree"),
      name: "tree",
      materialization: {
        kind: "artifact",
        artifact: {
          kind: "git-tree",
          locator: "artifacts/sk_tree/deadbeef",
          contentHash,
          integrityHash: contentHash,
          sizeBytes: 12,
        },
      },
    };
    const staged = await new ExactContentMaterializer(undefined, async () => new Uint8Array(), async () => input).stage(lock);
    try { expect(await readFile(join(staged.directory, "SKILL.md"), "utf8")).toBe("# Git tree\n"); }
    finally { await staged.cleanup(); }
  });

  test("stages artifacts without contacting upstream, with or without retained source metadata", async () => {
    const input = await mkdtemp(join(tmpdir(), "corotum-exact-artifact-")); directories.push(input);
    await writeFile(join(input, "SKILL.md"), "# Artifact\n");
    const archive = await createArtifactArchive(input);
    for (const source of [undefined, { repository: "https://unreachable.invalid/skill.git", path: "skill", ref: "main" }]) {
      const lock: V2LockedSkill = { id: skillId("sk_artifact"), name: "artifact", ...(source ? { source } : {}), materialization: { kind: "artifact", artifact: { kind: "r2-tar-zst", locator: "ignored", ...archive } } };
      const staged = await new ExactContentMaterializer(undefined, async () => archive.bytes).stage(lock);
      try { expect(await readFile(join(staged.directory, "SKILL.md"), "utf8")).toBe("# Artifact\n"); }
      finally { await staged.cleanup(); }
    }
  });

  test("maps failures deterministically and removes failed staging", async () => {
    const fixture = await sourceFixture();
    const mismatch = { ...sourceLock(fixture), materialization: { kind: "source" as const, contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const }, source: { ...sourceLock(fixture).source!, contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const } };
    const rootsBefore = (await readdir(tmpdir())).filter((name) => name.startsWith("corotum-materialize-"));
    await expect(new ExactContentMaterializer().stage(mismatch)).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("corotum-materialize-")).sort()).toEqual(rootsBefore.sort());
    await expect(new ExactContentMaterializer().stage({ ...sourceLock(fixture), source: { ...sourceLock(fixture).source!, repository: join(fixture.root, "absent") } })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const privateGit = new GitSkillMaterializer(async () => ({ exitCode: 128, stderr: "terminal prompts disabled", stdout: new Uint8Array() }));
    await expect(new ExactContentMaterializer(privateGit).stage(sourceLock(fixture))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(mapMaterializationError(new GitSourceError("AUTH_REQUIRED", "private")).code).toBe("AUTH_REQUIRED");
    expect(mapMaterializationError(Object.assign(new Error("offline"), { code: "NETWORK_ERROR" })).code).toBe("NETWORK_ERROR");
    expect(mapMaterializationError(Object.assign(new Error("drift"), { code: "DRIFTED" })).code).toBe("DRIFTED");
    expect(mapMaterializationError(new CanonicalStoreError("collision", "LOCAL_CONFLICT")).code).toBe("LOCAL_CONFLICT");
    const unavailable: V2LockedSkill = { id: skillId("sk_missing"), name: "missing", materialization: { kind: "artifact", artifact: { kind: "r2-tar-zst", locator: join(fixture.root, "missing.tar.zst"), contentHash: fixture.contentHash, integrityHash: fixture.contentHash, sizeBytes: 0 } } };
    await expect(new ExactContentMaterializer().stage(unavailable)).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
  });
});
