export const RELEASE_CHANNEL = "pipeline-proof" as const;
export const RELEASE_SCHEMA_VERSION = 1;
export const R2_RELEASE_PREFIX = "releases";

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
  binary: "toolmirror" | "toolmirror.exe";
}>;

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    id: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    archive: "toolmirror-darwin-arm64.tar.gz",
    binary: "toolmirror",
  },
  {
    id: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    archive: "toolmirror-darwin-x64.tar.gz",
    binary: "toolmirror",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    archive: "toolmirror-linux-arm64.tar.gz",
    binary: "toolmirror",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    archive: "toolmirror-linux-x64.tar.gz",
    binary: "toolmirror",
  },
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    archive: "toolmirror-windows-x64.tar.gz",
    binary: "toolmirror.exe",
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
  final: false;
  notes: string;
  artifacts: Readonly<Record<ReleaseTargetId, ReleaseArtifact>>;
}>;

export const PIPELINE_PROOF_NOTES =
  "v0.1 pipeline-proof artifacts. Unsigned. Not a final release. Manual binary download is not an officially supported installation method.";

export const UNSIGNED_NOTICE =
  "ToolMirror v0.1 binaries are unsigned. Signing and notarization are out of scope for v0.1.";

export const PIPELINE_PROOF_NOTICE = `${PIPELINE_PROOF_NOTES}\n`;

export function compiledBinaryName(target: ReleaseTarget): string {
  return target.id === "windows-x64"
    ? `toolmirror-${target.id}.exe`
    : `toolmirror-${target.id}`;
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
  const header = `# SHA-256 checksums for ToolMirror v${version} (unsigned ${RELEASE_CHANNEL})\n`;
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
    final: false,
    notes: PIPELINE_PROOF_NOTES,
    artifacts,
  };
}

export function r2ObjectKeys(version: string): string[] {
  return [
    `${R2_RELEASE_PREFIX}/latest.json`,
    `${versionDir(version)}/checksums.txt`,
    `${versionDir(version)}/UNSIGNED`,
    `${versionDir(version)}/PIPELINE_PROOF`,
    ...RELEASE_TARGETS.map((target) => artifactObject(version, target.archive)),
  ];
}

export type LayoutFile = Readonly<{ path: string; contents: Uint8Array }>;

export function verifyReleaseLayout(
  version: string,
  files: ReadonlyMap<string, Uint8Array>,
  sha256: (bytes: Uint8Array) => string,
): string[] {
  const errors: string[] = [];
  const expected = new Set(r2ObjectKeys(version));
  for (const key of expected) {
    if (!files.has(key)) errors.push(`missing ${key}`);
  }
  for (const key of files.keys()) {
    if (!expected.has(key)) errors.push(`unexpected ${key}`);
  }
  if (errors.length > 0) return errors;

  let latest: LatestJson;
  try {
    latest = JSON.parse(
      new TextDecoder().decode(files.get(`${R2_RELEASE_PREFIX}/latest.json`)),
    ) as LatestJson;
  } catch {
    return ["latest.json is not valid JSON"];
  }

  if (latest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    errors.push("latest.json schemaVersion must be 1");
  }
  if (latest.version !== version) errors.push("latest.json version mismatch");
  if (latest.channel !== RELEASE_CHANNEL) {
    errors.push("latest.json must use the pipeline-proof channel");
  }
  if (latest.unsigned !== true) errors.push("v0.1 binaries must be unsigned");
  if (latest.final !== false) {
    errors.push("pipeline-proof artifacts must not be marked final");
  }
  if (latest.notes !== PIPELINE_PROOF_NOTES) {
    errors.push("latest.json notes must identify non-final unsigned artifacts");
  }

  const unsigned = new TextDecoder().decode(
    files.get(`${versionDir(version)}/UNSIGNED`),
  );
  if (!unsigned.includes("unsigned")) {
    errors.push("UNSIGNED marker is missing the unsigned notice");
  }
  const proof = new TextDecoder().decode(
    files.get(`${versionDir(version)}/PIPELINE_PROOF`),
  );
  if (
    !proof.includes("pipeline-proof") ||
    !proof.includes("Not a final release")
  ) {
    errors.push("PIPELINE_PROOF marker is incomplete");
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

  for (const target of RELEASE_TARGETS) {
    const object = artifactObject(version, target.archive);
    const relative = `binaries/${target.archive}`;
    const bytes = files.get(object);
    if (!bytes) continue;
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
  return errors;
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
