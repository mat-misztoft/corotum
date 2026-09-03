export const RELEASE_CHANNEL = "v0.1" as const;
export const RELEASE_SCHEMA_VERSION = 1;
export const R2_RELEASE_PREFIX = "releases";
export const PIPELINE_PROOF_REUSE_ERROR =
  "pipeline-proof artifacts must not be reused";

export type ReleaseTargetId =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

export type ReleaseTarget = Readonly<{
  id: ReleaseTargetId;
  bunTarget: `bun-${ReleaseTargetId}`;
  archive: string;
  binary: "corotum" | "corotum.exe";
}>;

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    id: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    archive: "corotum-darwin-arm64.tar.gz",
    binary: "corotum",
  },
  {
    id: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    archive: "corotum-darwin-x64.tar.gz",
    binary: "corotum",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    archive: "corotum-linux-arm64.tar.gz",
    binary: "corotum",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    archive: "corotum-linux-x64.tar.gz",
    binary: "corotum",
  },
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    archive: "corotum-windows-x64.tar.gz",
    binary: "corotum.exe",
  },
];

export type ReleaseArtifact = Readonly<{
  object: string;
  sha256: string;
  filename: string;
  binary: ReleaseTarget["binary"];
}>;

export type LatestJson = Readonly<{
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  version: string;
  channel: typeof RELEASE_CHANNEL;
  unsigned: true;
  final: true;
  notes: string;
  artifacts: Readonly<Record<ReleaseTargetId, ReleaseArtifact>>;
}>;

export const FINAL_NOTES =
  "Corotum v0.5. Unsigned. Official installers are the only supported installation method. Manual binary download is not an officially supported installation method.";

export const UNSIGNED_NOTICE =
  "Corotum v0.5 binaries are unsigned. Signing and notarization are out of scope for v0.5.";

export function compiledBinaryName(target: ReleaseTarget): string {
  return target.id === "windows-x64"
    ? `corotum-${target.id}.exe`
    : `corotum-${target.id}`;
}

export function versionDir(version: string): string {
  return `${R2_RELEASE_PREFIX}/v${version}`;
}

export function artifactObject(version: string, filename: string): string {
  return `${versionDir(version)}/binaries/${filename}`;
}

export function checksumLine(sha256: string, relativePath: string): string {
  return `${sha256}  ${relativePath}`;
}

export function formatChecksums(
  version: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const header = `# SHA-256 checksums for Corotum v${version} (unsigned ${RELEASE_CHANNEL} final)\n`;
  return `${header}${entries.map(([sha, path]) => checksumLine(sha, path)).join("\n")}\n`;
}

export function parseChecksums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid checksums.txt line: ${line}`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function isGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function sourceMarker(sourceSha: string): string {
  if (!isGitSha(sourceSha)) {
    throw new Error("sourceSha must be a 40-character lowercase git SHA");
  }
  return `sourceSha=${sourceSha}\nchannel=${RELEASE_CHANNEL}\nunsigned=true\nfinal=true\n`;
}

export function parseSourceMarker(text: string): string {
  if (text.toLowerCase().includes("pipeline-proof")) {
    throw new Error(PIPELINE_PROOF_REUSE_ERROR);
  }
  const match = /^sourceSha=([a-f0-9]{40})$/m.exec(text);
  if (!match) {
    throw new Error("SOURCE marker is missing sourceSha");
  }
  if (
    !text.includes("unsigned=true") ||
    !text.includes("final=true") ||
    !text.includes(`channel=${RELEASE_CHANNEL}`)
  ) {
    throw new Error(
      "SOURCE marker must declare unsigned final release artifacts",
    );
  }
  return match[1];
}

export function buildLatestJson(
  version: string,
  sha256ByTarget: Readonly<Record<ReleaseTargetId, string>>,
): LatestJson {
  const artifacts = Object.fromEntries(
    RELEASE_TARGETS.map((target) => [
      target.id,
      {
        object: artifactObject(version, target.archive),
        sha256: sha256ByTarget[target.id],
        filename: target.archive,
        binary: target.binary,
      } satisfies ReleaseArtifact,
    ]),
  ) as Record<ReleaseTargetId, ReleaseArtifact>;
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    version,
    channel: RELEASE_CHANNEL,
    unsigned: true,
    final: true,
    notes: FINAL_NOTES,
    artifacts,
  };
}

export function r2ObjectKeys(version: string): string[] {
  return [
    `${R2_RELEASE_PREFIX}/latest.json`,
    `${versionDir(version)}/checksums.txt`,
    `${versionDir(version)}/UNSIGNED`,
    `${versionDir(version)}/SOURCE`,
    ...RELEASE_TARGETS.map((target) => artifactObject(version, target.archive)),
  ];
}

export function createReleaseLayout(
  version: string,
  archives: Readonly<Record<ReleaseTargetId, Uint8Array>>,
  sourceSha: string,
  sha256: (bytes: Uint8Array) => string,
): Map<string, Uint8Array> {
  const sha256ByTarget = {} as Record<ReleaseTargetId, string>;
  const checksumEntries: Array<readonly [string, string]> = [];
  const files = new Map<string, Uint8Array>();
  for (const target of RELEASE_TARGETS) {
    const bytes = archives[target.id];
    if (!bytes) throw new Error(`missing archive for ${target.id}`);
    const digest = sha256(bytes);
    sha256ByTarget[target.id] = digest;
    checksumEntries.push([digest, `binaries/${target.archive}`]);
    files.set(artifactObject(version, target.archive), bytes);
  }
  const encoder = new TextEncoder();
  files.set(
    `${versionDir(version)}/checksums.txt`,
    encoder.encode(formatChecksums(version, checksumEntries)),
  );
  files.set(
    `${versionDir(version)}/UNSIGNED`,
    encoder.encode(`${UNSIGNED_NOTICE}\n`),
  );
  files.set(
    `${versionDir(version)}/SOURCE`,
    encoder.encode(sourceMarker(sourceSha)),
  );
  files.set(
    `${R2_RELEASE_PREFIX}/latest.json`,
    encoder.encode(
      `${JSON.stringify(buildLatestJson(version, sha256ByTarget), null, 2)}\n`,
    ),
  );
  return files;
}

export type LayoutFile = Readonly<{ path: string; contents: Uint8Array }>;

export function verifyReleaseLayout(
  version: string,
  files: ReadonlyMap<string, Uint8Array>,
  sha256: (bytes: Uint8Array) => string,
  expectedSourceSha?: string,
): string[] {
  const errors: string[] = [];
  for (const key of files.keys()) {
    if (
      key.includes("PIPELINE_PROOF") ||
      key.toLowerCase().includes("pipeline-proof")
    ) {
      errors.push(PIPELINE_PROOF_REUSE_ERROR);
    }
  }
  const expected = new Set(r2ObjectKeys(version));
  for (const key of expected) {
    if (!files.has(key)) errors.push(`missing ${key}`);
  }
  for (const key of files.keys()) {
    if (!expected.has(key)) errors.push(`unexpected ${key}`);
  }
  if (errors.length > 0 && !files.has(`${R2_RELEASE_PREFIX}/latest.json`)) {
    return errors;
  }

  let latest: LatestJson;
  try {
    latest = JSON.parse(
      new TextDecoder().decode(files.get(`${R2_RELEASE_PREFIX}/latest.json`)),
    ) as LatestJson;
  } catch {
    return [...errors, "latest.json is not valid JSON"];
  }

  if (latest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    errors.push("latest.json schemaVersion must be 1");
  }
  if (latest.version !== version) errors.push("latest.json version mismatch");
  const channel = String(latest.channel);
  if (channel === "pipeline-proof") {
    errors.push(PIPELINE_PROOF_REUSE_ERROR);
  } else if (channel !== RELEASE_CHANNEL) {
    errors.push(`latest.json must use the ${RELEASE_CHANNEL} channel`);
  }
  if (latest.unsigned !== true)
    errors.push("release binaries must be unsigned");
  if (latest.final !== true) {
    errors.push("final artifacts must be marked final");
  }
  if (
    typeof latest.notes === "string" &&
    latest.notes.includes("pipeline-proof")
  ) {
    errors.push(PIPELINE_PROOF_REUSE_ERROR);
  } else if (latest.notes !== FINAL_NOTES) {
    errors.push(
      "latest.json notes must identify unsigned official installer artifacts",
    );
  }

  const unsigned = new TextDecoder().decode(
    files.get(`${versionDir(version)}/UNSIGNED`),
  );
  if (!unsigned?.includes("unsigned")) {
    errors.push("UNSIGNED marker is missing the unsigned notice");
  }

  const sourceBytes = files.get(`${versionDir(version)}/SOURCE`);
  if (sourceBytes) {
    try {
      const sourceSha = parseSourceMarker(
        new TextDecoder().decode(sourceBytes),
      );
      if (expectedSourceSha && sourceSha !== expectedSourceSha) {
        errors.push("SOURCE marker does not match the final source SHA");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let checksums: Map<string, string>;
  try {
    checksums = parseChecksums(
      new TextDecoder().decode(
        files.get(`${versionDir(version)}/checksums.txt`),
      ),
    );
  } catch (error) {
    return [...errors, error instanceof Error ? error.message : String(error)];
  }

  const decoder = new TextDecoder();
  for (const target of RELEASE_TARGETS) {
    const object = artifactObject(version, target.archive);
    const relative = `binaries/${target.archive}`;
    const bytes = files.get(object);
    if (!bytes) continue;
    const prefix = decoder.decode(bytes.slice(0, 32));
    if (prefix.includes("pipeline-proof")) {
      errors.push(PIPELINE_PROOF_REUSE_ERROR);
    }
    const digest = sha256(bytes);
    if (checksums.get(relative) !== digest) {
      errors.push(`checksum mismatch for ${relative}`);
    }
    const artifact = latest.artifacts?.[target.id];
    if (!artifact) {
      errors.push(`latest.json missing ${target.id}`);
      continue;
    }
    if (artifact.object !== object)
      errors.push(`${target.id} object path mismatch`);
    if (artifact.filename !== target.archive) {
      errors.push(`${target.id} filename mismatch`);
    }
    if (artifact.binary !== target.binary)
      errors.push(`${target.id} binary name mismatch`);
    if (artifact.sha256 !== digest) errors.push(`${target.id} sha256 mismatch`);
  }

  if (checksums.size !== RELEASE_TARGETS.length) {
    errors.push("checksums.txt must contain one entry per release target");
  }
  return [...new Set(errors)];
}

export function listUploadKeys(version: string): readonly string[] {
  return r2ObjectKeys(version);
}

export function releaseObjectType(key: string): string {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (key.endsWith(".tar.gz")) return "application/gzip";
  return "text/plain; charset=utf-8";
}

export async function uploadReleaseObjects(
  keys: readonly string[],
  read: (key: string) => Promise<Uint8Array>,
  write: (key: string, body: Uint8Array, type: string) => Promise<void>,
): Promise<readonly string[]> {
  for (const key of keys) {
    await write(key, await read(key), releaseObjectType(key));
  }
  return keys;
}
