import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import type { SourceLock } from "../../../packages/core/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { V2LocalApplier } from "./v2-local-applier";
import { V2MutationService } from "./v2-mutations";

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
            "Run corotum init before changing Git skill refs.",
          );
        const storage = effectiveStoragePaths(config, paths);
        const stateStore = new LocalOperationalStateStore(
          join(paths.stateDir, "state.json"),
        );
        const materializer = new GitSkillMaterializer();
        const result = await new V2MutationService(
          createCliV2GitStateProvider({
            storagePath: storage.gitStoragePath,
            source: config.gitRepository,
            options: program.opts(),
            io,
          }),
          {
            resolve: async (metadata): Promise<SourceLock> => {
              const resolved = await materializer.resolve({
                id: "pending-set-ref" as never,
                source: metadata.repository,
                skill: metadata.path,
                ref: metadata.ref,
                path: metadata.path,
              });
              return {
                ...resolved,
                ref: metadata.ref,
                contentHash: resolved.contentHash as `sha256:${string}`,
              };
            },
          },
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
        ).setRef(skill, ref);
        if (
          result.kind === "refused" ||
          result.kind === "source-unavailable" ||
          result.kind === "duplicate"
        )
          throw new Error(
            result.kind === "duplicate"
              ? "A managed skill already uses this name."
              : result.reason,
          );
        const output = {
          outcome:
            result.kind === "persisted-not-applied"
              ? "PARTIAL_SUCCESS"
              : "SUCCESS",
          status:
            result.kind === "persisted-not-applied"
              ? "PERSISTED_NOT_APPLIED"
              : "SET_REF",
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
