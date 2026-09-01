import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import type { CliIo } from "./cli";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { writeLifecycleResult } from "./remove-command";
import { V2LocalApplier } from "./v2-local-applier";
import { LifecycleRecoveryStore, V2LifecycleService } from "./v2-lifecycle";

/** Registers local-only exact-lock repair commands. */
export function registerRestoreCommand(program: Command, io: CliIo): void {
  program
    .command("restore <skill>")
    .description("restore managed skill content from its exact locked revision")
    .action(async (skill: string) => {
      const homeDir = homedir();
      const paths = resolvePlatformPaths({
        homeDir,
        platform: process.platform as "darwin" | "linux" | "win32",
        env: process.env,
      });
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const config = await new ConfigStore(paths).load();
        if (config.mode !== "git" || !config.gitRepository)
          throw new Error("Run corotum init before restoring Git skills.");
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
        writeLifecycleResult(
          io,
          program.opts<{ json?: boolean }>().json === true,
          await service.restore(skill),
          skill,
        );
      } finally {
        await release();
      }
    });
}
