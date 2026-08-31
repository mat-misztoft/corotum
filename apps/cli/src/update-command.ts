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
import { UpdateService } from "./update";

/** Registers upstream checks and explicit lockfile updates for Git Sync. */
export function registerUpdateCommand(program: Command, io: CliIo): void {
  program
    .command("update [skill]")
    .description("check upstream skill revisions or update exact locks")
    .option(
      "--check",
      "report upstream status without changing local or desired state",
    )
    .action(async (skill: string | undefined, options: { check?: boolean }) => {
      const homeDir = homedir();
      const paths = resolvePlatformPaths({
        homeDir,
        platform: process.platform as "darwin" | "linux" | "win32",
        env: process.env,
      });
      const config = await new ConfigStore(paths).load();
      if (config.mode !== "git" || !config.gitRepository)
        throw new Error("Run corotum init before updating Git skills.");
      const storage = effectiveStoragePaths(config, paths);
      const stateStore = new LocalOperationalStateStore(
        join(paths.stateDir, "state.json"),
      );
      const materializer = new GitSkillMaterializer();
      const service = new UpdateService(
        new GitStateProvider(storage.gitStoragePath, config.gitRepository),
        { resolve: (input) => materializer.resolve(input) },
        new LocalReconcileExecutor(
          stateStore,
          new CanonicalSkillStore(storage.skillsStoragePath),
          materializer,
        ),
      );
      const json = program.opts<{ json?: boolean }>().json === true;
      if (options.check) {
        const result = await service.check(skill);
        if ("kind" in result) throw new Error(result.reason);
        writeResult(io, json, {
          outcome: "SUCCESS",
          status: "CHECKED",
          skills: result,
        });
        return;
      }

      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const result = await service.update({
          name: skill,
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
        writeResult(io, json, {
          outcome: result.kind === "partial" ? "PARTIAL_SUCCESS" : "SUCCESS",
          status:
            result.kind === "updated"
              ? "UPDATED"
              : result.kind === "partial"
                ? "PARTIAL"
                : "UP_TO_DATE",
          skills: result.kind === "updated" ? result.skills : result.checks,
          ...(result.kind === "updated" || result.kind === "partial"
            ? { revision: result.revision }
            : {}),
        });
      } finally {
        await release();
      }
    });
}

function writeResult(
  io: CliIo,
  json: boolean,
  result: Record<string, unknown>,
): void {
  if (json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(result))}\n`);
    return;
  }
  io.writeOutput(`${result.status}\n`);
}
