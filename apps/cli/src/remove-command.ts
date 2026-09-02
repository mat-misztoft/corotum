import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { ConfigStore, effectiveStoragePaths } from "./config";
import {
  assertGitAvailable,
  notInitializedError,
  withGitCliErrors,
} from "./init-errors";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { V2LocalApplier } from "./v2-local-applier";
import {
  LifecycleRecoveryStore,
  V2LifecycleService,
  type V2LifecycleResult,
} from "./v2-lifecycle";

/** Registers desired-state deletion and local-preserving unmanage commands. */
export function registerRemoveCommands(program: Command, io: CliIo): void {
  for (const [name, operation, description] of [
    ["remove", "REMOVE", "remove a managed skill from every reconciled device"],
    [
      "unmanage",
      "UNMANAGE",
      "stop managing a skill while preserving local copies",
    ],
  ] as const) {
    program
      .command(`${name} <skill>`)
      .description(description)
      .action(async (skill: string) => {
        await withGitCliErrors(async () => {
        const homeDir = homedir();
        const paths = resolvePlatformPaths({
          homeDir,
          platform: process.platform as "darwin" | "linux" | "win32",
          env: process.env,
        });
        await assertGitAvailable();
        const release = await new MutationLock(
          join(paths.stateDir, "process.lock"),
        ).acquire();
        try {
          const config = await new ConfigStore(paths).load();
          if (config.mode !== "git" || !config.gitRepository)
            throw notInitializedError(`${name}ing Git skills`);
          const storage = effectiveStoragePaths(config, paths);
          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
          const service = new V2LifecycleService(
            createCliV2GitStateProvider({
              storagePath: storage.gitStoragePath,
              source: config.gitRepository,
              options: program.opts(),
              io,
            }),
            new V2LocalApplier(
              stateStore,
              new CanonicalSkillStore(storage.skillsStoragePath),
              {
                storagePath: storage.gitStoragePath,
                repository: config.gitRepository,
                enabledAgentIds: Object.entries(config.agents)
                  .filter(([, value]) => value.enabled)
                  .map(([id]) => id) as AgentId[],
                homeDir,
              },
            ),
            stateStore,
            new LifecycleRecoveryStore(
              join(paths.stateDir, "lifecycle-transaction.json"),
            ),
          );
          const result =
            operation === "REMOVE"
              ? await service.remove(skill)
              : await service.unmanage(skill);
          writeLifecycleResult(io, program.opts<{ json?: boolean }>().json === true, result, skill);
        } finally {
          await release();
        }
        });
      });
  }
}

export function writeLifecycleResult(
  io: CliIo,
  json: boolean,
  result: V2LifecycleResult,
  skill: string,
): void {
  if (result.kind === "refused") throw new Error(result.reason);
  if (result.kind === "local-conflict" || result.kind === "drifted") {
    throw new Error(result.reason);
  }
  const payload = {
    outcome: result.kind === "persisted-not-applied" ? "PARTIAL_SUCCESS" : "SUCCESS",
    status:
      result.kind === "persisted-not-applied"
        ? "PERSISTED_NOT_APPLIED"
        : result.operation,
    skill,
    skillId: result.skillId,
    revision: result.revision,
    ...(result.kind === "persisted-not-applied" ? { error: result.reason } : {}),
  };
  if (json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
    return;
  }
  io.writeOutput(`${payload.status} ${skill} at revision ${result.revision}.\n`);
}
