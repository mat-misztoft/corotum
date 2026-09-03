import type { Command } from "commander";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  gitSourceResolver,
  withV2MutationRuntime,
} from "./v2-mutation-session";
import { V2MutationService } from "./v2-mutations";

/** Registers an explicit Git ref change that resolves before desired-state mutation. */
export function registerSetRefCommand(program: Command, io: CliIo): void {
  program
    .command("set-ref <skill> <ref>")
    .description("change a managed skill ref and lock its exact content")
    .action(async (skill: string, ref: string) => {
      await withV2MutationRuntime(
        program,
        io,
        { action: "changing skill refs", requireGit: true },
        async (runtime) => {
          const release = await runtime.acquireLock();
          try {
            const result = await new V2MutationService(
              runtime.provider,
              gitSourceResolver(new GitSkillMaterializer()),
              runtime.applier,
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
            if (runtime.json) {
              io.writeOutput(`${JSON.stringify(jsonEnvelope(output))}\n`);
            } else {
              io.writeOutput(
                `Set ${skill} to ${ref} at revision ${result.revision}.\n`,
              );
            }
          } finally {
            await release();
          }
        },
      );
    });
}
