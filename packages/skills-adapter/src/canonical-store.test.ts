import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId } from "../../core/src/index";
import { CanonicalSkillStore, hashSkillDirectory } from "./canonical-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "corotum-canonical-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, "SKILL.md"), content);
  return join(directory, name);
}

describe("CanonicalSkillStore", () => {
  test("keeps skills with the same display name separate by stable ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    temporaryDirectories.push(root);
    const source = await fixture("frontend-design", "# Frontend design\n");
    const hash = await hashSkillDirectory(source);
    const store = new CanonicalSkillStore(root);
    const first = skillId("sk_first");
    const second = skillId("sk_second");

    await store.replaceFromDirectory(first, source, hash);
    await store.replaceFromDirectory(second, source, hash);

    expect(store.pathFor(first)).not.toBe(store.pathFor(second));
    expect(await readFile(join(store.pathFor(first), "SKILL.md"), "utf8")).toBe(
      "# Frontend design\n",
    );
    expect(
      await readFile(join(store.pathFor(second), "SKILL.md"), "utf8"),
    ).toBe("# Frontend design\n");
  });

  test("replaces only verified content", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    temporaryDirectories.push(root);
    const oldSource = await fixture("example", "# Old\n");
    const newSource = await fixture("example", "# New\n");
    const store = new CanonicalSkillStore(root);
    const id = skillId("sk_example");

    await store.replaceFromDirectory(
      id,
      oldSource,
      await hashSkillDirectory(oldSource),
    );
    await expect(
      store.replaceFromDirectory(id, newSource, "sha256:not-the-new-content"),
    ).rejects.toThrow("expected hash");
    expect(await readFile(join(store.pathFor(id), "SKILL.md"), "utf8")).toBe(
      "# Old\n",
    );

    const actualHash = await store.replaceFromDirectory(
      id,
      newSource,
      await hashSkillDirectory(newSource),
    );
    expect(actualHash).toBe(await hashSkillDirectory(store.pathFor(id)));
    expect(await readFile(join(store.pathFor(id), "SKILL.md"), "utf8")).toBe(
      "# New\n",
    );
  });

  test("rejects symlinks rather than hashing them as managed content", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    temporaryDirectories.push(root);
    const source = await fixture("example", "# Example\n");
    await symlink("SKILL.md", join(source, "linked.md"));
    const store = new CanonicalSkillStore(root);

    await expect(
      store.replaceFromDirectory(skillId("sk_example"), source, "sha256:wrong"),
    ).rejects.toThrow("only files and directories");
  });
});
