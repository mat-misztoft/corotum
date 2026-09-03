import { join } from "node:path";

import type { Command } from "commander";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  LifecycleRecoveryStore,
  type V2LifecycleResult,
  V2LifecycleService,
} from "./v2-lifecycle";
import { withV2MutationRuntime } from "./v2-mutation-session";

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
        await withV2MutationRuntime(
          program,
          io,
          { action: `${name}ing skills`, requireGit: false },
          async (runtime) => {
            const release = await runtime.acquireLock();
            try {
              const service = new V2LifecycleService(
                runtime.provider,
                runtime.applier,
                runtime.stateStore,
                new LifecycleRecoveryStore(
                  join(runtime.paths.stateDir, "lifecycle-transaction.json"),
                ),
              );
              const result =
                operation === "REMOVE"
                  ? await service.remove(skill)
                  : await service.unmanage(skill);
              writeLifecycleResult(io, runtime.json, result, skill);
            } finally {
              await release();
            }
          },
        );
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
    outcome:
      result.kind === "persisted-not-applied" ? "PARTIAL_SUCCESS" : "SUCCESS",
    status:
      result.kind === "persisted-not-applied"
        ? "PERSISTED_NOT_APPLIED"
        : result.operation,
    skill,
    skillId: result.skillId,
    revision: result.revision,
    ...(result.kind === "persisted-not-applied"
      ? { error: result.reason }
      : {}),
  };
  if (json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
    return;
  }
  io.writeOutput(
    `${payload.status} ${skill} at revision ${result.revision}.\n`,
  );
}
