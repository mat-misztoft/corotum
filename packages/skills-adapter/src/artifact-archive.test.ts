import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ArtifactArchiveError,
  createArtifactArchive,
  extractArtifactArchive,
  validatedTarFiles,
} from "./artifact-archive";

async function directory(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corotum-archive-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await Bun.write(target, content);
  }
  return root;
}

function tar(
  entries: readonly Readonly<{
    path: string;
    content?: string;
    type?: string;
    size?: number;
  }>[],
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content ?? "");
    const header = new Uint8Array(512);
    put(header, 0, 100, entry.path);
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.size ?? content.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    put(header, 257, 6, "ustar");
    put(header, 263, 2, "00");
    octal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    blocks.push(
      header,
      content,
      new Uint8Array((512 - (content.length % 512)) % 512),
    );
  }
  const length = blocks.reduce((sum, block) => sum + block.length, 1024);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.length;
  }
  return Bun.zstdCompressSync(output, { level: 6 });
}
function put(bytes: Uint8Array, offset: number, length: number, value: string) {
  bytes.set(new TextEncoder().encode(value).slice(0, length - 1), offset);
}
function octal(
  bytes: Uint8Array,
  offset: number,
  length: number,
  value: number,
) {
  put(bytes, offset, length, value.toString(8).padStart(length - 1, "0"));
}

const hash = (bytes: Uint8Array) => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return `sha256:${h.digest("hex")}` as const;
};

describe("deterministic artifact archives", () => {
  test("creates identical ordered, normalized tar.zst archives and extracts them", async () => {
    const source = await directory({ "z.txt": "z", "a.txt": "a" });
    const first = await createArtifactArchive(source);
    const second = await createArtifactArchive(source);
    expect(first).toEqual(second);
    const raw = Bun.zstdDecompressSync(first.bytes);
    expect(
      new TextDecoder().decode(raw.slice(0, 100)).replace(/\0.*$/, ""),
    ).toBe("a.txt");
    expect(
      new TextDecoder().decode(raw.slice(100, 108)).replace(/\0.*$/, ""),
    ).toBe("0000644");
    const destination = join(
      await mkdtemp(join(tmpdir(), "corotum-out-")),
      "skill",
    );
    await extractArtifactArchive(first.bytes, destination, first);
    expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("a");
  });

  for (const entries of [
    [{ path: "../escape", content: "x" }],
    [{ path: "/absolute", content: "x" }],
    [
      { path: "same", content: "x" },
      { path: "same", content: "y" },
    ],
    [{ path: "link", type: "2" }],
    [{ path: "hard", type: "1" }],
    [{ path: "device", type: "3" }],
    [{ path: "huge", content: "", size: 64 * 1024 * 1024 + 1 }],
  ])
    test("rejects unsafe or bomb archive entries before publishing", async () => {
      const bytes = tar(entries);
      const destination = join(
        await mkdtemp(join(tmpdir(), "corotum-dest-")),
        "skill",
      );
      await expect(
        extractArtifactArchive(bytes, destination, {
          integrityHash: hash(bytes),
          contentHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        }),
      ).rejects.toMatchObject<Partial<ArtifactArchiveError>>({
        code: "ARTIFACT_UNAVAILABLE",
      });
      await expect(access(destination)).rejects.toThrow();
    });

  test("rejects corrupt streams and declared integrity/content mismatch without replacing destination", async () => {
    const source = await directory({ "SKILL.md": "new" });
    const archive = await createArtifactArchive(source);
    const parent = await mkdtemp(join(tmpdir(), "corotum-existing-"));
    const destination = join(parent, "skill");
    await mkdir(destination);
    await Bun.write(join(destination, "SKILL.md"), "old");
    const corrupt = archive.bytes.slice();
    corrupt[0] ^= 1;
    await expect(
      extractArtifactArchive(corrupt, destination, {
        ...archive,
        integrityHash: hash(corrupt),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    await expect(
      extractArtifactArchive(archive.bytes, destination, {
        ...archive,
        integrityHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    await expect(
      extractArtifactArchive(archive.bytes, destination, {
        ...archive,
        contentHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("old");
    await rm(source, { force: true, recursive: true });
  });

  test("reads git-archive tars that omit block padding or EOF markers", () => {
    const content = new TextEncoder().encode("hi");
    const header = new Uint8Array(512);
    put(header, 0, 100, "a.txt");
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, content.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    put(header, 257, 6, "ustar");
    put(header, 263, 2, "00");
    octal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    const unpadded = new Uint8Array(header.length + content.length);
    unpadded.set(header);
    unpadded.set(content, header.length);
    expect(unpadded.length % 512).not.toBe(0);
    expect(validatedTarFiles(unpadded)).toEqual([{ path: "a.txt", content }]);
  });
});
