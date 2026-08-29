import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SanitizedLogger } from "./logs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function logDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toolmirror-logs-"));
  directories.push(directory);
  return join(directory, "logs");
}

describe("sanitized logs", () => {
  test("redacts tokens, URL credentials, sensitive paths, and skill content", async () => {
    const directory = await logDirectory();
    const logger = new SanitizedLogger(directory);
    await logger.write("sync.failed", {
      token: "abc123",
      source: "https://alex:password@example.test/skills.git",
      sensitivePath: "/private/toolmirror",
      skillContent: "private SKILL.md body",
      message: "Bearer session-value",
    });

    const output = await readFile(join(directory, "toolmirror.log"), "utf8");
    for (const secret of [
      "abc123",
      "alex:password",
      "/private/toolmirror",
      "private SKILL.md body",
      "session-value",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[REDACTED]");
  });

  test("rejects control characters in event names to block log injection", async () => {
    const directory = await logDirectory();
    const logger = new SanitizedLogger(directory);
    await logger.write('sync.failed\n{"token":"line-inject"}', {
      message: "ok",
    });
    const output = await readFile(join(directory, "toolmirror.log"), "utf8");
    expect(output).not.toContain("line-inject");
    expect(output).toContain("invalid.event");
  });

  test("keeps at most five rotated files at the configured size", async () => {
    const directory = await logDirectory();
    const maxBytes = 256;
    const logger = new SanitizedLogger(directory, { fileCount: 5, maxBytes });

    for (let index = 0; index < 12; index += 1) {
      await logger.write("event", { index, value: "short" });
    }

    const files = (await readdir(directory)).sort();
    expect(files).toEqual([
      "toolmirror.log",
      "toolmirror.log.1",
      "toolmirror.log.2",
      "toolmirror.log.3",
      "toolmirror.log.4",
    ]);
    await Promise.all(
      files.map(async (file) => {
        expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(
          maxBytes,
        );
      }),
    );
  });
});
