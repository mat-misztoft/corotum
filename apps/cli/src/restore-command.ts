import { join } from "node:path";

import type { Command } from "commander";
import type { CliIo } from "./cli";
import { writeLifecycleResult } from "./remove-command";
import { LifecycleRecoveryStore, V2LifecycleService } from "./v2-lifecycle";
import { withV2MutationRuntime } from "./v2-mutation-session";

/** Registers local-only exact-lock repair commands. */
export function registerRestoreCommand(program: Command, io: CliIo): void {
  program
    .command("restore <skill>")
    .description("restore managed skill content from its exact locked revision")
    .action(async (skill: string) => {
      await withV2MutationRuntime(
        program,
        io,
        { action: "restoring skills", requireGit: false },
        async (runtime) => {
          const release = await runtime.acquireLock();
          try {
            writeLifecycleResult(
              io,
              runtime.json,
              await new V2LifecycleService(
                runtime.provider,
                runtime.applier,
                runtime.stateStore,
                new LifecycleRecoveryStore(
                  join(runtime.paths.stateDir, "lifecycle-transaction.json"),
                ),
              ).restore(skill),
              skill,
            );
          } finally {
            await release();
          }
        },
      );
    });
}
