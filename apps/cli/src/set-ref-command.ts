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
import { SetRefService } from "./set-ref";

/** Registers an explicit Git ref change that resolves before desired-state mutation. */
export function registerSetRefCommand(program: Command, io: CliIo): void {
  program
    .command("set-ref <skill> <ref>")
    .description("change a managed skill ref and lock its exact content")
    .action(async (skill: string, ref: string) => {
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
          throw new Error(
            "Run toolmirror init before changing Git skill refs.",
          );
        const storage = effectiveStoragePaths(config, paths);
        const stateStore = new LocalOperationalStateStore(
          join(paths.stateDir, "state.json"),
        );
        const materializer = new GitSkillMaterializer();
        const result = await new SetRefService(
          new GitStateProvider(storage.gitStoragePath, config.gitRepository),
          { resolve: (input) => materializer.resolve(input) },
          new LocalReconcileExecutor(
            stateStore,
            new CanonicalSkillStore(storage.skillsStoragePath),
            materializer,
          ),
        ).setRef({
          name: skill,
          ref,
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
        const output = {
          outcome: "SUCCESS",
          status: "SET_REF",
          skillId: result.skillId,
          ref,
          revision: result.revision,
        };
        if (program.opts<{ json?: boolean }>().json) {
          io.writeOutput(`${JSON.stringify(jsonEnvelope(output))}\n`);
        } else {
          io.writeOutput(
            `Set ${skill} to ${ref} at revision ${result.revision}.\n`,
          );
        }
      } finally {
        await release();
      }
    });
}
