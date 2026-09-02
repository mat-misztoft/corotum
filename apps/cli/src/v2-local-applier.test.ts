import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { skillId, type V2DesiredState } from "../../../packages/core/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { LocalOperationalStateStore } from "./local-state";
import { V2LocalApplier } from "./v2-local-applier";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "corotum-v2-applier-"));
  directories.push(path);
  return path;
}

async function git(args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

function sourceKey(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

function applier(
  path: string,
  enabledAgentIds: readonly ("codex")[] = [],
): { applier: V2LocalApplier; state: LocalOperationalStateStore } {
  const state = new LocalOperationalStateStore(join(path, "state.json"));
  return {
    state,
    applier: new V2LocalApplier(state, new CanonicalSkillStore(join(path, "canonical")), {
      storagePath: join(path, "storage"),
      repository: "https://example.test/team/state.git",
      enabledAgentIds,
      homeDir: path,
    }),
  };
}

describe("V2LocalApplier", () => {
  test("materializes the exact locked source revision and persists verified local state", async () => {
    const path = await root();
    const repository = join(path, "upstream");
    await git(["init", "--initial-branch=main", repository]);
    await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
    await git(["-C", repository, "config", "user.name", "Corotum tests"]);
    await mkdir(join(repository, "skill"));
    await writeFile(join(repository, "skill", "SKILL.md"), "# Pinned\n");
    await git(["-C", repository, "add", "."]);
    await git(["-C", repository, "commit", "-m", "pinned"]);
    const revision = (await git(["-C", repository, "rev-parse", "HEAD"])).trim();
    const contentHash = (await scanNormalizedContent(join(repository, "skill"))).contentHash;
    await writeFile(join(repository, "skill", "SKILL.md"), "# Moved HEAD\n");
    await git(["-C", repository, "commit", "-am", "moved"]);

    const id = skillId("sk_source");
    const desired: V2DesiredState = { manifest: { version: 2, skills: [{ id, name: "source", targets: [] }] }, lockfile: { version: 2, skills: [{ id, name: "source", source: { repository, path: "skill", ref: "main", revision, contentHash }, materialization: { kind: "source", contentHash } }] } };
    const local = applier(path);
    await local.applier.apply({ state: desired, revisionId: "revision-1", skillIds: [id] });

    expect(await readFile(join(path, "canonical", "source", "SKILL.md"), "utf8")).toBe("# Pinned\n");
    expect(await local.state.load()).toMatchObject({ lastAppliedRevision: "revision-1", skills: { [id]: { name: "source", contentHash, ownership: "verified", targets: {} } } });
  });

  test("materializes an artifact without source metadata and persists it", async () => {
    const path = await root();
    const input = join(path, "artifact-input");
    await mkdir(input);
    await writeFile(join(input, "SKILL.md"), "# Local artifact\n");
    const archive = await createArtifactArchive(input);
    const id = skillId("sk_artifact");
    const locator = `artifacts/${id}/${archive.integrityHash.slice(7)}`;
    const storage = join(path, "storage", sourceKey("https://example.test/team/state.git"), locator);
    await mkdir(dirname(storage), { recursive: true });
    await Bun.write(storage, archive.bytes);
    const desired: V2DesiredState = { manifest: { version: 2, skills: [{ id, name: "artifact", targets: [] }] }, lockfile: { version: 2, skills: [{ id, name: "artifact", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator, ...archive } } }] } };
    const local = applier(path);
    await local.applier.apply({ state: desired, revisionId: "revision-2", skillIds: [id] });

    expect(await readFile(join(path, "canonical", "artifact", "SKILL.md"), "utf8")).toBe("# Local artifact\n");
    expect(await local.state.load()).toMatchObject({ lastAppliedRevision: "revision-2", skills: { [id]: { name: "artifact", contentHash: archive.contentHash, ownership: "verified", targets: {} } } });
  });

  test("enabling an agent later exposes managed skills and disable removes only exposure", async () => {
    const path = await root();
    const repository = join(path, "upstream");
    await git(["init", "--initial-branch=main", repository]);
    await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
    await git(["-C", repository, "config", "user.name", "Corotum tests"]);
    await mkdir(join(repository, "skill"));
    await writeFile(join(repository, "skill", "SKILL.md"), "# Pinned\n");
    await git(["-C", repository, "add", "."]);
    await git(["-C", repository, "commit", "-m", "pinned"]);
    const revision = (await git(["-C", repository, "rev-parse", "HEAD"])).trim();
    const contentHash = (await scanNormalizedContent(join(repository, "skill"))).contentHash;
    const id = skillId("sk_source");
    const desired: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "source", targets: "all" }] },
      lockfile: {
        version: 2,
        skills: [{
          id,
          name: "source",
          source: { repository, path: "skill", ref: "main", revision, contentHash },
          materialization: { kind: "source", contentHash },
        }],
      },
    };
    const installed = applier(path);
    await installed.applier.apply({ state: desired, revisionId: "revision-1", skillIds: [id] });
    const target = join(path, ".codex", "skills", "source");
    await expect(lstat(target)).rejects.toThrow();

    const enabled = applier(path, ["codex"]);
    await enabled.applier.applyEnableAgent(desired);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(path, "canonical", "source", "SKILL.md"), "utf8")).toBe("# Pinned\n");
    expect((await enabled.state.load())?.lastAppliedRevision).toBe("revision-1");

    await enabled.applier.applyDisableAgent("codex");
    await expect(lstat(target)).rejects.toThrow();
    expect(await readFile(join(path, "canonical", "source", "SKILL.md"), "utf8")).toBe("# Pinned\n");
    expect((await enabled.state.load())?.lastAppliedRevision).toBe("revision-1");
    expect((await enabled.state.load())?.skills[id]?.targets).toEqual({});
  });
});
