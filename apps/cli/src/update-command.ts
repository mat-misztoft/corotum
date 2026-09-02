import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import type { SourceLock } from "../../../packages/core/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
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
import { V2MutationService } from "./v2-mutations";

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
      await withGitCliErrors(async () => {
      const homeDir = homedir();
      const paths = resolvePlatformPaths({
        homeDir,
        platform: process.platform as "darwin" | "linux" | "win32",
        env: process.env,
      });
      await assertGitAvailable();
      const config = await new ConfigStore(paths).load();
      if (config.mode !== "git" || !config.gitRepository)
        throw notInitializedError("updating Git skills");
      const storage = effectiveStoragePaths(config, paths);
      const stateStore = new LocalOperationalStateStore(
        join(paths.stateDir, "state.json"),
      );
      const materializer = new GitSkillMaterializer();
      const service = new V2MutationService(
        createCliV2GitStateProvider({
          storagePath: storage.gitStoragePath,
          source: config.gitRepository,
          options: program.opts(),
          io,
        }),
        {
          resolve: async (metadata): Promise<SourceLock> => {
            const resolved = await materializer.resolve({
              id: "pending-update" as never,
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
      );
      const json = program.opts<{ json?: boolean }>().json === true;
      if (options.check) {
        const skills = await service.check(skill);
        writeResult(io, json, {
          outcome: "SUCCESS",
          status: "CHECKED",
          skills,
        });
        return;
      }

      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const results = await service.update(skill);
        const refused = results.find((result) => result.kind === "refused");
        if (refused?.kind === "refused") throw new Error(refused.reason);
        const partial = results.some(
          (result) => result.kind === "persisted-not-applied",
        );
        const unavailable = results.some(
          (result) => result.kind === "source-unavailable",
        );
        writeResult(io, json, {
          outcome: partial ? "PARTIAL_SUCCESS" : "SUCCESS",
          status: partial
            ? "PERSISTED_NOT_APPLIED"
            : unavailable
              ? "SOURCE_UNAVAILABLE"
              : "UPDATED",
          skills: results,
        });
      } finally {
        await release();
      }
      });
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
  io.writeOutput(formatUpdateHuman(result));
}

function formatUpdateHuman(result: Record<string, unknown>): string {
  const skills = result.skills;
  if (result.status === "CHECKED" && Array.isArray(skills)) {
    if (skills.length === 0) return "No managed skills.\n";
    return `${skills
      .map((skill) => {
        const row = skill as { name?: string; skillId?: string; status?: string };
        return `${row.name ?? row.skillId ?? "skill"}\t${row.status ?? ""}`;
      })
      .join("\n")}\n`;
  }
  if (Array.isArray(skills) && skills.length > 0) {
    const lines = skills.map((skill) => {
      const row = skill as {
        skillId?: string;
        kind?: string;
        revision?: string;
      };
      return `${row.skillId ?? "skill"}\t${row.kind ?? result.status}${row.revision ? `\t${row.revision}` : ""}`;
    });
    return `${result.status}\n${lines.join("\n")}\n`;
  }
  return `${result.status}\n`;
}
