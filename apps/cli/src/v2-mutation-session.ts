import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import type { SourceLock } from "../../../packages/core/src/index";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { CLI_VERSION, type CliIo } from "./cli";
import { CloudAuthError, resolveCloudOrigin } from "./cloud-auth";
import {
  ConfigStore,
  type CorotumConfig,
  CredentialsStore,
  effectiveStoragePaths,
} from "./config";
import { classifyCloudInspectError } from "./init-cloud";
import {
  assertGitAvailable,
  notInitializedError,
  withGitCliErrors,
} from "./init-errors";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { V2LocalApplier } from "./v2-local-applier";
import { cloudState } from "./v2-migration";
import type { V2MutationProvider, V2SourceResolver } from "./v2-mutations";

export type V2MutationRuntime = Readonly<{
  homeDir: string;
  config: CorotumConfig;
  storage: ReturnType<typeof effectiveStoragePaths>;
  paths: ReturnType<typeof resolvePlatformPaths>;
  stateStore: LocalOperationalStateStore;
  provider: V2MutationProvider;
  applier: V2LocalApplier;
  json: boolean;
  acquireLock: () => Promise<() => Promise<void>>;
}>;

/** Git and Cloud skill mutations share one v2 runtime; Cloud never uses a second stack. */
export async function withV2MutationRuntime<T>(
  program: Command,
  io: CliIo,
  options: Readonly<{ action: string; requireGit: boolean }>,
  work: (runtime: V2MutationRuntime) => Promise<T>,
): Promise<T> {
  return withGitCliErrors(async () => {
    try {
      return await work(await createV2MutationRuntime(program, io, options));
    } catch (error) {
      throw classifyCloudMutationError(error);
    }
  });
}

export function gitSourceResolver(
  materializer: GitSkillMaterializer = new GitSkillMaterializer(),
  skillName?: string,
): V2SourceResolver {
  return {
    resolve: async (metadata): Promise<SourceLock> => {
      const resolved = await materializer.resolve({
        id: "pending-mutation" as never,
        source: metadata.repository,
        skill: skillName ?? metadata.path,
        ref: metadata.ref,
        path: metadata.path,
      });
      return {
        ...resolved,
        ref: metadata.ref,
        contentHash: resolved.contentHash as `sha256:${string}`,
      };
    },
  };
}

async function createV2MutationRuntime(
  program: Command,
  io: CliIo,
  options: Readonly<{ action: string; requireGit: boolean }>,
): Promise<V2MutationRuntime> {
  const homeDir = homedir();
  const paths = resolvePlatformPaths({
    homeDir,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const config = await new ConfigStore(paths).load();
  if (config.mode !== "git" && config.mode !== "cloud") {
    throw notInitializedError(options.action);
  }
  if (config.mode === "git" && !config.gitRepository) {
    throw notInitializedError(options.action);
  }
  if (config.mode === "git" || options.requireGit) await assertGitAvailable();
  const storage = effectiveStoragePaths(config, paths);
  const stateStore = new LocalOperationalStateStore(
    join(paths.stateDir, "state.json"),
  );
  const enabledAgentIds = Object.entries(config.agents)
    .filter(([, value]) => value.enabled)
    .map(([id]) => id) as AgentId[];
  const { provider, cloud } = await mutationProvider(
    program,
    io,
    config,
    storage,
    paths,
  );
  const applier = new V2LocalApplier(
    stateStore,
    new CanonicalSkillStore(storage.skillsStoragePath),
    {
      storagePath: storage.gitStoragePath,
      repository: config.gitRepository ?? "cloud",
      enabledAgentIds,
      homeDir,
      artifactReader: cloud
        ? async (locator) => {
            const snapshot = await cloud.pull();
            const lock = snapshot.state.lockfile.skills.find(
              (skill) =>
                skill.materialization.kind === "artifact" &&
                skill.materialization.artifact.locator === locator,
            );
            if (!lock)
              throw new Error("Artifact locator is not in desired state.");
            return cloud.downloadArtifact(lock);
          }
        : undefined,
    },
  );
  return {
    homeDir,
    config,
    storage,
    paths,
    stateStore,
    provider,
    applier,
    json: program.opts<{ json?: boolean }>().json === true,
    acquireLock: () =>
      new MutationLock(join(paths.stateDir, "process.lock")).acquire(),
  };
}

async function mutationProvider(
  program: Command,
  io: CliIo,
  config: CorotumConfig,
  storage: ReturnType<typeof effectiveStoragePaths>,
  paths: ReturnType<typeof resolvePlatformPaths>,
): Promise<Readonly<{ provider: V2MutationProvider; cloud?: V2SaaSProvider }>> {
  if (config.mode === "git") {
    return {
      provider: createCliV2GitStateProvider({
        storagePath: storage.gitStoragePath,
        source: config.gitRepository as string,
        options: program.opts(),
        io,
      }),
    };
  }
  const credentials = await new CredentialsStore(paths).load();
  if (!credentials.cloudDeviceToken || !config.workspaceId) {
    throw new CloudAuthError(
      "Run corotum login before changing Cloud skills.",
      "AUTH_REQUIRED",
    );
  }
  const origin = resolveCloudOrigin(undefined, config.origin);
  const cloud = new V2SaaSProvider({
    origin,
    deviceToken: credentials.cloudDeviceToken,
    workspaceId: config.workspaceId,
    cliVersion: CLI_VERSION,
  });
  const workspaceId = config.workspaceId;
  return {
    cloud,
    provider: {
      pull: async () => {
        const pulled = await cloud.pull();
        return {
          revisionId: pulled.revisionId ?? "",
          state: pulled.state,
          ledger: pulled.ledger,
        };
      },
      push: async (input) => {
        const archives: Record<
          string,
          Awaited<ReturnType<typeof createArtifactArchive>>
        > = {};
        const artifacts: Record<string, Uint8Array> = {};
        for (const [id, directory] of Object.entries(input.artifacts ?? {})) {
          const archive = await createArtifactArchive(directory);
          archives[id] = archive;
          artifacts[id] = archive.bytes;
        }
        const pushed = await cloud.push({
          state: cloudState(input.state, workspaceId, archives),
          ledger: input.ledger,
          baseRevision: input.baseRevision || null,
          artifacts,
        });
        if (!pushed.revisionId) {
          throw new Error("Cloud did not return a revision.");
        }
        return {
          revisionId: pushed.revisionId,
          state: pushed.state,
          ledger: pushed.ledger,
        };
      },
    },
  };
}

function classifyCloudMutationError(error: unknown): Error {
  return classifyCloudInspectError(error);
}
