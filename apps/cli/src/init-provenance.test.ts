import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverInitProvenance } from "./init-provenance";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(lock: unknown, names = ["review"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corotum-init-"));
  roots.push(root);
  const skills = join(root, ".agents", "skills");
  await mkdir(skills, { recursive: true });
  for (const name of names) {
    await mkdir(join(skills, name));
    await writeFile(join(skills, name, "SKILL.md"), `# ${name}\n`);
  }
  if (lock !== undefined) await writeFile(join(root, ".agents", ".skill-lock.json"), JSON.stringify(lock));
  return root;
}

const record = {
  source: "skills.sh",
  sourceType: "github",
  sourceUrl: "owner/skills",
  skillPath: "skills/review",
  skillFolderHash: "sha256:recorded",
};

describe("init provenance discovery", () => {
  test("reads shared skills and normalized credential-free provenance without mutation", async () => {
    const root = await fixture({ skills: { review: record } });
    const skillFile = join(root, ".agents", "skills", "review", "SKILL.md");
    const before = await readFile(skillFile, "utf8");
    await expect(discoverInitProvenance(root)).resolves.toEqual([expect.objectContaining({
      name: "review",
      path: join(root, ".agents", "skills", "review"),
      provenance: { status: "source-known", ...record, sourceUrl: "https://github.com/owner/skills.git" },
    })]);
    expect(await readFile(skillFile, "utf8")).toBe(before);
  });

  test("marks missing, malformed, and stale mappings source-unknown", async () => {
    const missing = await fixture(undefined);
    const malformed = await fixture("not a lockfile");
    const incomplete = await fixture({ skills: { review: { ...record, sourceType: "" } } });
    const stale = await fixture({ skills: { other: record } });
    for (const root of [missing, malformed, incomplete, stale]) {
      const [candidate] = await discoverInitProvenance(root);
      expect(candidate.provenance.status).toBe("source-unknown");
    }
    expect((await discoverInitProvenance(malformed))[0].provenance).toMatchObject({ reason: "invalid-lockfile" });
  });

  test("requires every provenance field", async () => {
    for (const field of Object.keys(record)) {
      const value = { ...record, [field]: undefined };
      const root = await fixture({ skills: { review: value } });
      const [candidate] = await discoverInitProvenance(root);
      expect(candidate.provenance).toMatchObject({ status: "source-unknown", reason: "missing-provenance" });
    }
  });

  test("matches skills.sh lock keys and strips SKILL.md from the upstream path", async () => {
    const root = await fixture({
      version: 1,
      skills: {
        "twitter-x-posts": {
          ...record,
          skillPath: "skills/platforms/x/SKILL.md",
        },
        review: {
          ...record,
          skillPath: "skills/review/SKILL.md",
          sourceUrl: "owner/other",
        },
      },
    }, ["review", "twitter-x-posts"]);
    const candidates = await discoverInitProvenance(root);
    expect(candidates).toEqual([
      expect.objectContaining({
        name: "review",
        provenance: expect.objectContaining({
          status: "source-known",
          skillPath: "skills/review",
          sourceUrl: "https://github.com/owner/other.git",
        }),
      }),
      expect.objectContaining({
        name: "twitter-x-posts",
        provenance: expect.objectContaining({
          status: "source-known",
          skillPath: "skills/platforms/x",
          sourceUrl: "https://github.com/owner/skills.git",
        }),
      }),
    ]);
  });

  test("rejects credential URLs and normalizes local path separators", async () => {
    const unsafe = await fixture({ skills: { review: { ...record, sourceUrl: "https://token@github.com/owner/skills.git" } } });
    const normalized = await fixture({ skills: { review: { ...record, skillPath: "skills\\review" } } });
    expect((await discoverInitProvenance(unsafe))[0].provenance.status).toBe("source-unknown");
    expect((await discoverInitProvenance(normalized))[0].provenance).toMatchObject({ status: "source-known", skillPath: "skills/review" });
  });

  test("retains duplicate normalized local names as independent evidence", async () => {
    // Trailing space works on case-insensitive filesystems.
    const root = await fixture({ skills: { first: { ...record, skillPath: "review" }, second: { ...record, skillPath: "review " } } }, ["review", "review "]);
    const candidates = await discoverInitProvenance(root);
    expect(candidates.map((candidate) => candidate.normalizedName)).toEqual(["review", "review"]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.provenance.status === "source-unknown")).toBe(true);
  });
});
