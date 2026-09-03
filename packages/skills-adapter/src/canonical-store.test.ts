import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId } from "../../core/src/index";
import { CanonicalSkillStore, hashSkillDirectory } from "./canonical-store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  ),
);

async function fixture(
  root: string,
  name: string,
  content: string,
): Promise<string> {
  const path = join(root, `${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), content);
  return path;
}

describe("CanonicalSkillStore", () => {
  test("installs named content atomically while stable ID remains metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    directories.push(root);
    const source = await fixture(root, "source", "# Example\n");
    const store = new CanonicalSkillStore(join(root, "skills"));
    const id = skillId("sk_stablemetadata");
    const hash = await hashSkillDirectory(source);

    await store.replaceFromDirectory(id, "example", source, hash);

    expect(store.pathFor("example")).toBe(join(root, "skills", "example"));
    expect(
      await readFile(join(store.pathFor("example"), "SKILL.md"), "utf8"),
    ).toBe("# Example\n");
    expect(await readdir(join(root, "skills"))).toEqual(["example"]);
  });

  test("preserves verified prior content and cleans staging when replacement verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    directories.push(root);
    const oldSource = await fixture(root, "old", "# Old\n");
    const newSource = await fixture(root, "new", "# New\n");
    const store = new CanonicalSkillStore(join(root, "skills"));
    const id = skillId("sk_example");
    const oldHash = await hashSkillDirectory(oldSource);
    await store.replaceFromDirectory(id, "example", oldSource, oldHash);

    await expect(
      store.replaceFromDirectory(id, "example", newSource, "sha256:wrong", {
        skillId: id,
        contentHash: oldHash,
      }),
    ).rejects.toThrow("expected hash");

    expect(
      await readFile(join(store.pathFor("example"), "SKILL.md"), "utf8"),
    ).toBe("# Old\n");
    expect(await readdir(join(root, "skills"))).toEqual(["example"]);
  });

  test("rejects unmanaged and case-colliding named directories without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-store-"));
    directories.push(root);
    const source = await fixture(root, "source", "# Managed\n");
    const store = new CanonicalSkillStore(join(root, "skills"));
    await mkdir(store.pathFor("Example"), { recursive: true });
    await writeFile(
      join(store.pathFor("Example"), "SKILL.md"),
      "# Unmanaged\n",
    );

    await expect(
      store.replaceFromDirectory(
        skillId("sk_example"),
        "Example",
        source,
        await hashSkillDirectory(source),
      ),
    ).rejects.toMatchObject({ code: "LOCAL_CONFLICT" });
    expect(
      await readFile(join(store.pathFor("Example"), "SKILL.md"), "utf8"),
    ).toBe("# Unmanaged\n");
  });
});
