import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContentScanError,
  scanNormalizedContent,
} from "./normalized-content";

async function skill(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corotum-content-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("normalized content scanning", () => {
  test("applies ordered ignore rules deterministically and excludes its configuration", async () => {
    const root = await skill({
      ".corotumignore": "*.tmp\n!keep.tmp\nnotes/*.md\n",
      "z.md": "z",
      "a.md": "a",
      "drop.tmp": "no",
      "keep.tmp": "yes",
      "notes/private.md": "no",
    });
    const first = await scanNormalizedContent(root);
    const second = await scanNormalizedContent(root);
    expect(first.files.map((file) => file.path)).toEqual([
      "a.md",
      "keep.tmp",
      "z.md",
    ]);
    expect(second).toEqual(first);
  });

  test("ignored content does not affect the normalized hash", async () => {
    const root = await skill({
      ".corotumignore": "ignored.txt\n",
      "SKILL.md": "ok",
      "ignored.txt": "one",
    });
    const before = await scanNormalizedContent(root);
    await writeFile(join(root, "ignored.txt"), "two");
    expect((await scanNormalizedContent(root)).contentHash).toBe(
      before.contentHash,
    );
  });

  test.each([
    [".env", ".env"],
    [".env.local", ".env.*"],
    [".npmrc", ".npmrc"],
    [".netrc", ".netrc"],
    ["certificate.pem", "*.pem"],
    ["private.key", "*.key"],
    ["archive.p12", "*.p12"],
    ["archive.pfx", "*.pfx"],
    ["value.secret", "*.secret"],
    ["id_rsa", "id_rsa"],
    ["id_dsa", "id_dsa"],
    ["id_ecdsa", "id_ecdsa"],
    ["id_ed25519", "id_ed25519"],
    ["credentials", "credentials"],
    ["credentials.json", "credentials.*"],
    ["secrets", "secrets"],
    ["secrets.json", "secrets.*"],
  ])("rejects denylisted %s before returning content", async (path, rule) => {
    const root = await skill({
      ".corotumignore": `${path}\n`,
      [path]: "secret",
    });
    await expect(scanNormalizedContent(root)).rejects.toMatchObject<
      Partial<ContentScanError>
    >({ code: "DENYLISTED_PATH", message: expect.stringContaining(rule) });
  });

  test("rejects symlinks and malformed, empty, or conflicting ignore files without following them", async () => {
    const root = await skill({ "SKILL.md": "ok" });
    await symlink(join(root, "SKILL.md"), join(root, "linked.md"));
    await expect(scanNormalizedContent(root)).rejects.toMatchObject({
      code: "UNSAFE_ENTRY",
    });

    for (const ignore of ["", "../escape", "*.md\n!*.md\n"]) {
      const caseRoot = await skill({
        ".corotumignore": ignore,
        "SKILL.md": "ok",
      });
      await expect(scanNormalizedContent(caseRoot)).rejects.toMatchObject({
        code: "INVALID_IGNORE",
      });
    }
  });

  test("rejects a linked ignore file and never returns partial output", async () => {
    const root = await skill({ rules: "*.txt\n", "SKILL.md": "ok" });
    await symlink(join(root, "rules"), join(root, ".corotumignore"));
    await expect(scanNormalizedContent(root)).rejects.toMatchObject({
      code: "UNSAFE_ENTRY",
    });
  });

  test("rejects denylisted directories even when ignored", async () => {
    const root = await skill({
      ".corotumignore": ".env/**\n",
      ".env/token": "secret",
    });
    await expect(scanNormalizedContent(root)).rejects.toMatchObject<
      Partial<ContentScanError>
    >({
      code: "DENYLISTED_PATH",
      message: expect.stringContaining(".env"),
    });
  });

  test("rejects an unreadable file without returning a partial result", async () => {
    const root = await skill({
      "SKILL.md": "ok",
      "private.txt": "not readable",
    });
    const privatePath = join(root, "private.txt");
    await chmod(privatePath, 0o000);
    try {
      await expect(scanNormalizedContent(root)).rejects.toMatchObject({
        code: "UNREADABLE_ENTRY",
      });
    } finally {
      await chmod(privatePath, 0o600);
    }
  });

  test("rejects a symlinked content root", async () => {
    const root = await skill({ "SKILL.md": "ok" });
    const linkedRoot = `${root}-linked`;
    await symlink(root, linkedRoot);
    await expect(scanNormalizedContent(linkedRoot)).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });
});
