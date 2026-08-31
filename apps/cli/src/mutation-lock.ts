import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class MutationLockedError extends Error {
  constructor(readonly pid: number) {
    super(`Another Corotum mutation is already running (PID ${pid}).`);
    this.name = "MutationLockedError";
  }
}

export class MutationLock {
  constructor(
    private readonly file: string,
    private readonly isProcessAlive: (pid: number) => boolean = processIsAlive,
  ) {}

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.file, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
        } finally {
          await handle.close();
        }
        return async () => {
          await rm(this.file, { force: true });
        };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;

        const pid = await readLockPid(this.file);
        if (this.isProcessAlive(pid)) throw new MutationLockedError(pid);
        await rm(this.file, { force: true });
      }
    }

    throw new Error("Unable to acquire the Corotum mutation lock.");
  }
}

async function readLockPid(file: string): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Corotum mutation lock is invalid; remove it manually.");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    throw new Error("Corotum mutation lock is invalid; remove it manually.");
  }
  return value.pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
