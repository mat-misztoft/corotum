import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";
import { RestoreService } from "./restore";

/** Registers local-only exact-lock repair commands. */
export function registerRestoreCommand(program: Command, io: CliIo): void {
  program
    .command("restore [skill]")
    .description("restore managed skill content from its exact locked revision")
    .option("--all", "restore every resolved managed skill")
    .action(async (skill: string | undefined, options: { all?: boolean }) => {
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
        const result = await new RestoreService(
          new GitStateProvider(storage.gitStoragePath, config.gitRepository),
          new LocalReconcileExecutor(
            stateStore,
            new CanonicalSkillStore(storage.skillsStoragePath),
            new GitSkillMaterializer(),
          ),
        ).restore({
          name: skill,
          all: options.all === true,
          execution: {
            enabledAgentIds: Object.entries(config.agents)
              .filter(([, value]) => value.enabled)
              .map(([id]) => id) as AgentId[],
            homeDir,
            state: (await stateStore.load()) ?? {
              schemaVersion: 1,
              lastAppliedRevision: null,
              skills: {},
            },
          },
        });
        if (result.kind === "refused") throw new Error(result.reason);
        const json = program.opts<{ json?: boolean }>().json === true;
        const output = {
          outcome: result.kind === "partial" ? "PARTIAL_SUCCESS" : "SUCCESS",
          status: result.kind === "partial" ? "PARTIAL" : "RESTORED",
          skills: result.skills,
        };
        if (json) io.writeOutput(`${JSON.stringify(jsonEnvelope(output))}\n`);
        else io.writeOutput(`${output.status} ${result.skills.join(", ")}.\n`);
      } finally {
        await release();
      }
    });
}
