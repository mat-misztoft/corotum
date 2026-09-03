import type { Command } from "commander";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  gitSourceResolver,
  withV2MutationRuntime,
} from "./v2-mutation-session";
import { V2MutationService } from "./v2-mutations";

/** Registers upstream checks and explicit lockfile updates. */
export function registerUpdateCommand(program: Command, io: CliIo): void {
  program
    .command("update [skill]")
    .description("check upstream skill revisions or update exact locks")
    .option(
      "--check",
      "report upstream status without changing local or desired state",
    )
    .action(async (skill: string | undefined, options: { check?: boolean }) => {
      await withV2MutationRuntime(
        program,
        io,
        { action: "updating skills", requireGit: true },
        async (runtime) => {
          const service = new V2MutationService(
            runtime.provider,
            gitSourceResolver(new GitSkillMaterializer()),
            runtime.applier,
          );
          if (options.check) {
            writeResult(io, runtime.json, {
              outcome: "SUCCESS",
              status: "CHECKED",
              skills: await service.check(skill),
            });
            return;
          }

          const release = await runtime.acquireLock();
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
            writeResult(io, runtime.json, {
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
        },
      );
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
