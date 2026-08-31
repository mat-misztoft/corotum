import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOG_FILE_COUNT = 5;
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const REDACTED = "[REDACTED]";

type LogValue =
  | boolean
  | number
  | string
  | null
  | LogValue[]
  | { [key: string]: LogValue };

export class SanitizedLogger {
  constructor(
    private readonly directory: string,
    private readonly options: Readonly<{
      fileCount?: number;
      maxBytes?: number;
    }> = {},
  ) {}

  async write(
    event: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event: sanitizeEventName(event),
      details: sanitizeLogValue(details),
    });
    const maxBytes = this.options.maxBytes ?? LOG_FILE_MAX_BYTES;
    const line = `${Buffer.byteLength(entry, "utf8") <= maxBytes ? entry : JSON.stringify({ timestamp: new Date().toISOString(), event, details: "[TRUNCATED]" })}\n`;
    const file = join(this.directory, "corotum.log");

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await sizeOf(file)) + Buffer.byteLength(line, "utf8") > maxBytes) {
      await this.rotate(file);
    }
    await writeFile(file, line, { encoding: "utf8", flag: "a", mode: 0o600 });
  }

  private async rotate(file: string): Promise<void> {
    const fileCount = this.options.fileCount ?? LOG_FILE_COUNT;
    await rm(`${file}.${fileCount - 1}`, { force: true });
    for (let index = fileCount - 2; index >= 1; index -= 1) {
      await renameIfPresent(`${file}.${index}`, `${file}.${index + 1}`);
    }
    await renameIfPresent(file, `${file}.1`);
  }
}

function sanitizeEventName(event: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(event)) return event;
  return "invalid.event";
}

/** Removes secrets and content that local logs must never retain. */
export function sanitizeLogValue(value: unknown, key = ""): LogValue {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "boolean" || typeof value === "number" || value === null)
    return value;
  if (Array.isArray(value))
    return value.map((item) => sanitizeLogValue(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeLogValue(entryValue, entryKey),
      ]),
    );
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|credential|password|skill.?content|sensitive.?path|device.?code|user.?code)/i.test(
    key,
  );
}

function sanitizeString(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(
      /([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
      `$1${REDACTED}@`,
    )
    .replace(
      /\b((?:token|secret|password|credential)\s*[=:]\s*)[^\s,;]+/gi,
      `$1${REDACTED}`,
    );
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
