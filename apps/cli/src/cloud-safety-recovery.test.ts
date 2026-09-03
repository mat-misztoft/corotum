import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ARTIFACT_DESCRIPTOR_HEADER } from "../../../packages/saas-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 45_000;
const deviceToken = "plaintext-device-token-secret";
const deviceId = "dev_1";
const workspaceId = "ws_1";
const emptyLedger = { version: 2, activeDispositions: {} };
const emptyState = {
  manifest: { version: 2, skills: [] as unknown[] },
  lockfile: { version: 2, skills: [] as unknown[] },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await Bun.spawn(["chmod", "-R", "u+rwx", root], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-cloud-safety-${name}-`));
  roots.push(path);
  return path;
}

function platformEnv(home: string) {
  return {
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_RUNTIME_DIR: join(home, ".local", "runtime"),
    },
  };
}

function paths(home: string) {
  return resolvePlatformPaths(platformEnv(home));
}

function cliEnv(
  home: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const overlay = platformEnv(home).env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("XDG_")) env[key] = value;
  }
  return {
    ...env,
    ...overlay,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Corotum tests",
    GIT_AUTHOR_EMAIL: "tests@corotum.invalid",
    GIT_COMMITTER_NAME: "Corotum tests",
    GIT_COMMITTER_EMAIL: "tests@corotum.invalid",
    FORCE_COLOR: "0",
    ...Object.fromEntries(
      Object.entries(extra).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

type CliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}>;

async function spawnCli(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: cliEnv(home, extraEnv),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let json: Record<string, unknown> | undefined;
  const line = stdout.trim().split("\n").at(-1);
  if (line?.startsWith("{")) json = JSON.parse(line) as Record<string, unknown>;
  return { code, stdout, stderr, json };
}

function combined(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.json ?? {})}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(directory: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
}

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
}

async function seedCloudHome(home: string): Promise<void> {
  const resolved = paths(home);
  await writeJson(resolved.configFile, {
    ...defaultConfig(),
    mode: "cloud",
    workspaceId,
    deviceId,
  });
  await writeJson(resolved.credentialsFile, {
    schemaVersion: 1,
    cloudDeviceToken: deviceToken,
  });
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function skillRepo(
  root: string,
  name: string,
  body: string,
): Promise<{ repository: string; revision: string; contentHash: string }> {
  const repository = join(root, `${name}.git`);
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", repository, "config", "user.name", "Corotum tests"]);
  await writeSkill(join(repository, "skills", name), body);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", name]);
  return {
    repository,
    revision: await git(["-C", repository, "rev-parse", "HEAD"]),
    contentHash: (
      await scanNormalizedContent(join(repository, "skills", name))
    ).contentHash,
  };
}

function sourceState(
  id: string,
  name: string,
  source: Awaited<ReturnType<typeof skillRepo>>,
) {
  return {
    manifest: {
      version: 2,
      skills: [
        {
          id,
          name,
          targets: "all",
          source: {
            repository: source.repository,
            path: `skills/${name}`,
            ref: "main",
          },
          resolutionStatus: "RESOLVED",
        },
      ],
    },
    lockfile: {
      version: 2,
      skills: [
        {
          id,
          name,
          source: {
            repository: source.repository,
            path: `skills/${name}`,
            ref: "main",
            revision: source.revision,
            contentHash: source.contentHash,
          },
          materialization: {
            kind: "source",
            contentHash: source.contentHash,
          },
        },
      ],
    },
  };
}

type CloudFault =
  | "ok"
  | "unauthorized"
  | "revoked"
  | "hosted"
  | "outage"
  | "missing-artifact"
  | "corrupt-artifact";

function startCloudServer(options?: {
  state?: typeof emptyState;
  ledger?: typeof emptyLedger;
  revisionId?: string;
  artifacts?: Map<string, Uint8Array>;
}): {
  origin: string;
  stop: () => void;
  fault: { current: CloudFault };
  reports: Record<string, unknown>[];
  setState: (
    state: typeof emptyState,
    revisionId: string,
    ledger?: typeof emptyLedger,
  ) => void;
  artifacts: Map<string, Uint8Array>;
} {
  const artifacts = options?.artifacts ?? new Map<string, Uint8Array>();
  const reports: Record<string, unknown>[] = [];
  const fault = { current: "ok" as CloudFault };
  let revisionId = options?.revisionId ?? "rev_empty";
  let state = options?.state ?? emptyState;
  let ledger = options?.ledger ?? emptyLedger;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (fault.current === "outage") {
        return Response.json(
          { error: "Cloud origin is unreachable." },
          { status: 503 },
        );
      }
      const url = new URL(request.url);
      if (fault.current === "unauthorized") {
        return Response.json({ error: "expired" }, { status: 401 });
      }
      if (fault.current === "revoked") {
        return Response.json(
          { error: "Device token revoked" },
          { status: 401 },
        );
      }
      if (fault.current === "hosted") {
        return Response.json(
          { error: "Hosted Cloud subscription required" },
          { status: 402 },
        );
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/state$/.test(url.pathname)) {
        if (request.method === "GET") {
          return Response.json({
            revisionId,
            revisionSequence: 1,
            state,
            dispositionLedger: ledger,
          });
        }
        if (request.method === "PUT") {
          const body = (await request.json()) as {
            state?: typeof emptyState;
            dispositionLedger?: typeof emptyLedger;
          };
          state = body.state ?? state;
          ledger = body.dispositionLedger ?? ledger;
          revisionId = "rev_mutated";
          return Response.json({
            revisionId,
            revisionSequence: 2,
            state,
            dispositionLedger: ledger,
          });
        }
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/artifacts$/.test(url.pathname)) {
        const descriptor = JSON.parse(
          request.headers.get(ARTIFACT_DESCRIPTOR_HEADER) ?? "null",
        ) as { artifact?: { locator?: string } } | null;
        const locator = descriptor?.artifact?.locator;
        if (!locator) {
          return Response.json({ error: "missing artifact" }, { status: 400 });
        }
        if (request.method === "GET") {
          if (fault.current === "missing-artifact") {
            return Response.json(
              { error: "Artifact object is missing." },
              { status: 404 },
            );
          }
          if (fault.current === "corrupt-artifact") {
            return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
          }
          const bytes = artifacts.get(locator);
          if (!bytes) {
            return Response.json(
              { error: "Artifact object is missing." },
              { status: 404 },
            );
          }
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
      }
      if (/\/api\/v1\/devices\/[^/]+\/sync-report$/.test(url.pathname)) {
        const body = (await request.json()) as Record<string, unknown>;
        reports.push(body);
        return Response.json({
          deviceId,
          workspaceId,
          appliedRevisionId: body.appliedRevisionId ?? null,
          appliedRevisionSequence: 1,
          syncStatus: body.syncStatus,
          lastErrorCode: body.lastErrorCode ?? null,
          lastErrorMessage: body.lastErrorMessage ?? null,
          lastSyncAt: Date.now(),
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    fault,
    reports,
    artifacts,
    setState(next, nextRevision, nextLedger) {
      state = next;
      revisionId = nextRevision;
      if (nextLedger) ledger = nextLedger;
    },
  };
}

describe("Cloud safety and recovery", () => {
  test(
    "revoked and expired tokens are typed login errors and never print the token",
    async () => {
      const home = await temp("token");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const cloud = startCloudServer();
      try {
        cloud.fault.current = "unauthorized";
        const expired = await spawnCli(
          home,
          ["--json", "--non-interactive", "status"],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(expired.code).toBe(ExitCode.AUTH_REQUIRED);
        expect(expired.json?.outcome).toBe("AUTH_REQUIRED");
        expect(combined(expired)).toContain("corotum login");
        expect(combined(expired)).not.toContain(deviceToken);
        expect(combined(expired)).not.toMatch(/Git remote is unavailable/i);

        cloud.fault.current = "revoked";
        const revoked = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(revoked.code).toBe(ExitCode.AUTH_REQUIRED);
        expect(combined(revoked)).toContain("corotum login");
        expect(combined(revoked)).not.toContain(deviceToken);
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "hosted 402 after pairing stays entitlement-gated and does not mutate local files",
    async () => {
      const root = await temp("hosted");
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const home = join(root, "home");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const cloud = startCloudServer();
      cloud.fault.current = "hosted";
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        const status = await spawnCli(
          home,
          ["--json", "--non-interactive", "status"],
          env,
        );
        expect(status.code).toBe(ExitCode.GENERAL_ERROR);
        expect(combined(status)).toContain("Hosted Cloud subscription required");
        expect(combined(status)).not.toContain(deviceToken);

        const added = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "add",
            notes.repository,
            "--skill",
            "notes",
            "--ref",
            "main",
          ],
          env,
        );
        expect(added.code).toBe(ExitCode.GENERAL_ERROR);
        expect(combined(added)).toContain("Hosted Cloud subscription required");
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
        await expect(
          readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).rejects.toThrow();
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "Cloud outage is a Cloud network error, not a Git remote error, and preserves drift",
    async () => {
      const root = await temp("outage");
      const notes = await skillRepo(root, "notes", "# Locked\n");
      const home = join(root, "home");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const cloud = startCloudServer({
        state: sourceState("sk_notesoutage0001", "notes", notes),
        revisionId: "rev_locked",
      });
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        const installed = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(installed.json?.status).toBe("SYNCED");
        await writeFile(join(namedSkill(home, "notes"), "SKILL.md"), "# Drifted\n");
        const drifted = await spawnCli(
          home,
          ["--json", "--non-interactive", "status"],
          env,
        );
        expect(drifted.json?.status).toBe("DRIFTED");
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Drifted\n");

        cloud.fault.current = "outage";
        const sync = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(sync.code).toBe(ExitCode.NETWORK_ERROR);
        expect(combined(sync)).toMatch(/Cloud is unreachable/i);
        expect(combined(sync)).not.toMatch(/Git remote is unavailable/i);
        expect(combined(sync)).not.toContain(deviceToken);
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Drifted\n");
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");

        const removed = await spawnCli(
          home,
          ["--json", "--non-interactive", "remove", "notes"],
          env,
        );
        expect(removed.code).toBe(ExitCode.NETWORK_ERROR);
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Drifted\n");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "missing/corrupt R2 artifacts and hash mismatch leave unmanaged files and last local content",
    async () => {
      const root = await temp("artifact");
      const home = join(root, "home");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const staged = join(root, "staged");
      await writeSkill(staged, "# Artifact locked\n");
      const archive = await createArtifactArchive(staged);
      const id = "sk_customartifact0001";
      const locator = `workspaces/${workspaceId}/artifacts/${id}/${archive.integrityHash}.tar.zst`;
      const state = {
        manifest: {
          version: 2,
          skills: [
            {
              id,
              name: "custom",
              targets: "all",
              resolutionStatus: "RESOLVED",
            },
          ],
        },
        lockfile: {
          version: 2,
          skills: [
            {
              id,
              name: "custom",
              materialization: {
                kind: "artifact",
                artifact: {
                  kind: "r2-tar-zst",
                  contentHash: archive.contentHash,
                  integrityHash: archive.integrityHash,
                  locator,
                  sizeBytes: archive.sizeBytes,
                },
              },
            },
          ],
        },
      };
      const artifacts = new Map<string, Uint8Array>([[locator, archive.bytes]]);
      const cloud = startCloudServer({
        state,
        revisionId: "rev_artifact",
        artifacts,
      });
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        cloud.fault.current = "missing-artifact";
        const missing = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(missing.json?.status).not.toBe("SYNCED");
        expect(combined(missing)).toMatch(/ARTIFACT_UNAVAILABLE|missing/i);
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");

        cloud.fault.current = "corrupt-artifact";
        const corrupt = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(corrupt.json?.status).not.toBe("SYNCED");
        expect(combined(corrupt)).not.toContain(deviceToken);

        cloud.fault.current = "ok";
        const mutated = archive.bytes.slice();
        mutated[mutated.length - 1] = (mutated[mutated.length - 1]! + 1) & 0xff;
        artifacts.set(locator, mutated);
        const mismatch = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(mismatch.json?.status).not.toBe("SYNCED");
        expect(combined(mismatch)).toMatch(
          /CONTENT_HASH_MISMATCH|ARTIFACT_UNAVAILABLE|hash/i,
        );
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "private source AUTH_REQUIRED, no HEAD fallback, and ledger REMOVE/UNMANAGE keep unmanaged copies",
    async () => {
      const root = await temp("lifecycle");
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const classified = await skillRepo(root, "classified", "# Secret\n");
      const home = join(root, "home");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const locked = sourceState("sk_noteslock0001", "notes", notes);
      const cloud = startCloudServer({
        state: locked,
        revisionId: "rev_locked",
      });
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        const installed = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(installed.json?.status).toBe("SYNCED");
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes locked\n");

        await writeFile(
          join(notes.repository, "skills", "notes", "SKILL.md"),
          "# Notes HEAD\n",
        );
        await git(["-C", notes.repository, "add", "."]);
        await git(["-C", notes.repository, "commit", "-m", "move head"]);
        const again = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(again.json?.status).toBe("SYNCED");
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes locked\n");

        await Bun.spawn(["chmod", "-R", "a-rwx", classified.repository], {
          stderr: "pipe",
          stdout: "pipe",
        }).exited;
        cloud.setState(
          sourceState("sk_classified0001", "classified", classified),
          "rev_private",
        );
        await writeSkill(namedSkill(home, "classified"), "# Local classified\n");
        const auth = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(["AUTH_REQUIRED", "PARTIALLY_SYNCED", "LOCAL_CONFLICT"]).toContain(
          auth.json?.status,
        );
        expect(
          await readFile(
            join(namedSkill(home, "classified"), "SKILL.md"),
            "utf8",
          ),
        ).toBe("# Local classified\n");
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
        expect(combined(auth)).not.toContain(deviceToken);

        await writeSkill(namedSkill(home, "extra"), "# Extra locked\n");
        cloud.setState(emptyState, "rev_ledger", {
          version: 2,
          activeDispositions: {
            sk_noteslock0001: {
              skillId: "sk_noteslock0001",
              name: "notes",
              disposition: "REMOVE",
              effectiveSequence: 2,
            },
            sk_extralock0001: {
              skillId: "sk_extralock0001",
              name: "extra",
              disposition: "UNMANAGE",
              effectiveSequence: 2,
            },
          },
        });
        const ledgered = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(ledgered.json?.status).not.toBeUndefined();
        expect(
          await readFile(join(namedSkill(home, "extra"), "SKILL.md"), "utf8"),
        ).toBe("# Extra locked\n");
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
