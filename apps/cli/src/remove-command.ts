import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import type { SkillId } from "../../../packages/core/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import type { LocalOperationalState } from "./local-state";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";
import { RemoveService, type UnmanageConflictChoice } from "./remove";

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
              `Run toolmirror init before ${name}ing Git skills.`,
            );
          const storage = effectiveStoragePaths(config, paths);
          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
          const state = (await stateStore.load()) ?? emptyState();
          const provider = new GitStateProvider(
            storage.gitStoragePath,
            config.gitRepository,
          );
          const current = await provider.pull();
          if (current.kind !== "success")
            throw new Error(
              current.kind === "failure"
                ? current.error.message
                : "Desired state is incomplete.",
            );
          const managed = current.value.state.manifest.skills.find(
            (candidate) => candidate.id === skill || candidate.skill === skill,
          );
          if (!managed) throw new Error("Managed skill was not found.");
          const nonInteractive =
            program.opts<{ nonInteractive?: boolean }>().nonInteractive ===
              true || !io.stdinIsTTY;
          const choices =
            operation === "UNMANAGE"
              ? await chooseUnmanageConflicts(state, managed.id, nonInteractive)
              : {};
          const result = await new RemoveService(
            provider,
            new LocalReconcileExecutor(
              stateStore,
              new CanonicalSkillStore(storage.skillsStoragePath),
              new GitSkillMaterializer(),
            ),
          ).remove({
            name: managed.id,
            operation,
            unmanageChoices: choices,
            execution: {
              enabledAgentIds: Object.entries(config.agents)
                .filter(([, value]) => value.enabled)
                .map(([id]) => id) as AgentId[],
              homeDir,
              state,
            },
          });
          if (result.kind === "refused") throw new Error(result.reason);
          writeResult(io, program.opts<{ json?: boolean }>().json === true, {
            outcome: result.kind === "partial" ? "PARTIAL_SUCCESS" : "SUCCESS",
            status: result.kind.toUpperCase(),
            revision: result.revision,
            skill: managed.skill,
            ...(result.kind === "partial" ? { error: result.reason } : {}),
          });
        } finally {
          await release();
        }
      });
  }
}

export async function chooseUnmanageConflicts(
  state: LocalOperationalState,
  id: SkillId,
  nonInteractive: boolean,
): Promise<Record<string, UnmanageConflictChoice>> {
  const targets = Object.values(state.skills[id]?.targets ?? {});
  const conflicts = [] as typeof targets;
  for (const target of targets) {
    if (
      target.mode === "symlink" &&
      !(await isManagedSymlink(target.path, state.skills[id]?.canonicalPath))
    ) {
      conflicts.push(target);
    }
  }
  if (conflicts.length === 0) return {};
  if (nonInteractive)
    throw new Error(
      "An unmanaged target conflicts with this skill; use an interactive terminal to keep, replace, or cancel.",
    );

  const choices: Record<string, UnmanageConflictChoice> = {};
  for (const target of conflicts) {
    choices[target.path] = await selectConflictChoice(target.path);
  }
  return choices;
}

async function isManagedSymlink(
  path: string,
  canonicalPath: string | undefined,
): Promise<boolean> {
  if (!canonicalPath) return false;
  try {
    return (
      (await lstat(path)).isSymbolicLink() &&
      (await realpath(path)) === (await realpath(canonicalPath))
    );
  } catch {
    return false;
  }
}

async function selectConflictChoice(
  path: string,
): Promise<UnmanageConflictChoice> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = (
      await prompt.question(
        `Unmanaged target conflicts at ${path}. Keep existing [k], replace with managed version [r], or cancel [c]? `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "k" || answer === "keep") return "keep";
    if (answer === "r" || answer === "replace") return "replace";
    throw new Error("Unmanage cancelled.");
  } finally {
    prompt.close();
  }
}

function emptyState(): LocalOperationalState {
  return { schemaVersion: 1, lastAppliedRevision: null, skills: {} };
}

function writeResult(
  io: CliIo,
  json: boolean,
  result: Record<string, string>,
): void {
  if (json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(result))}\n`);
    return;
  }
  io.writeOutput(
    `${result.status} ${result.skill} at revision ${result.revision}.\n`,
  );
}
