import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MutationLock, MutationLockedError } from "./mutation-lock";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function lockFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toolmirror-lock-"));
  directories.push(directory);
  return join(directory, "runtime", "process.lock");
}

describe("mutation lock", () => {
  test("rejects a second mutating process while a live PID owns the lock", async () => {
    const file = await lockFile();
    const first = new MutationLock(file, (pid) => pid === process.pid);
    const release = await first.acquire();

    await expect(
      new MutationLock(file, (pid) => pid === process.pid).acquire(),
    ).rejects.toEqual(expect.any(MutationLockedError));
    await release();
  });

  test("removes a stale dead-PID lock before acquiring", async () => {
    const file = await lockFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"pid":12345}\n');
    const lock = new MutationLock(file, () => false);

    const release = await lock.acquire();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      pid: process.pid,
    });
    await release();
  });

  test("read-only work does not need or acquire the mutation lock", async () => {
    const file = await lockFile();
    const release = await new MutationLock(file, () => true).acquire();

    const readOnlyOperation = async () => "available";
    await expect(readOnlyOperation()).resolves.toBe("available");
    await release();
  });
});
