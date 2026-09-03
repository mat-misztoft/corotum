import type { Command } from "commander";
import {
  GitSkillMaterializer,
  normalizeGitSource,
} from "../../../packages/skills-adapter/src/git-source";
import type { AddCandidate } from "./add";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { selectOption } from "./prompts";
import {
  gitSourceResolver,
  withV2MutationRuntime,
} from "./v2-mutation-session";
import { V2MutationService } from "./v2-mutations";

/** Registers Git-backed skill addition for Git Sync and Cloud Sync. */
export function registerAddCommand(program: Command, io: CliIo): void {
  program
    .command("add <source>")
    .description("resolve and add one skill from a Git source")
    .option("--skill <name>", "skill name to add")
    .option("--ref <ref>", "branch, tag, or commit to lock", "HEAD")
    .action(
      async (sourceInput: string, options: { skill?: string; ref: string }) => {
        await withV2MutationRuntime(
          program,
          io,
          { action: "adding skills", requireGit: true },
          async (runtime) => {
            const source = normalizeGitSource(sourceInput);
            const materializer = new GitSkillMaterializer();
            const candidates = await materializer.discover(source, options.ref);
            const candidate = await selectCandidate(
              candidates,
              options.skill,
              program.opts<{ nonInteractive?: boolean }>().nonInteractive ===
                true || !io.stdinIsTTY,
            );
            const release = await runtime.acquireLock();
            try {
              const result = await new V2MutationService(
                runtime.provider,
                gitSourceResolver(materializer, candidate.name),
                runtime.applier,
              ).add({
                name: candidate.name,
                source: {
                  repository: source,
                  path: candidate.path,
                  ref: options.ref,
                },
              });
              if (result.kind === "refused") throw new Error(result.reason);
              if (result.kind === "duplicate") {
                writeResult(io, runtime.json, {
                  outcome: "SUCCESS",
                  status: "DUPLICATE",
                  skillId: result.skillId,
                });
                return;
              }
              if (result.kind === "source-unavailable")
                throw new Error(result.reason);
              writeResult(io, runtime.json, {
                outcome:
                  result.kind === "persisted-not-applied"
                    ? "PARTIAL_SUCCESS"
                    : "SUCCESS",
                status:
                  result.kind === "persisted-not-applied"
                    ? "PERSISTED_NOT_APPLIED"
                    : "ADDED",
                skill: candidate.name,
                skillId: result.skillId,
                revision: result.revision,
              });
            } finally {
              await release();
            }
          },
        );
      },
    );
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
    result.status === "DUPLICATE"
      ? `Skill already managed as ${result.skillId}.\n`
      : `Added ${result.skill} at revision ${result.revision}.\n`,
  );
}

export async function selectCandidate(
  candidates: readonly AddCandidate[],
  requested: string | undefined,
  nonInteractive: boolean,
): Promise<AddCandidate> {
  const matches = requested
    ? candidates.filter((candidate) => candidate.name === requested)
    : candidates;
  if (matches.length === 0)
    throw new Error(
      requested
        ? `Skill ${requested} was not found in this source.`
        : "No Agent Skills were found in this source.",
    );
  if (requested && matches.length === 1) return matches[0];
  if (nonInteractive)
    throw new Error(
      requested
        ? `Skill ${requested} is ambiguous; use a source with a unique skill name.`
        : "Use --skill when adding from a source with multiple skills in non-interactive mode.",
    );
  if (matches.length === 1) return matches[0];

  const path = await selectOption(
    "Choose a skill",
    matches.map((candidate) => ({
      value: candidate.path,
      label: `${candidate.name} (${candidate.path})`,
    })),
  );
  const selected = matches.find((candidate) => candidate.path === path);
  if (!selected) throw new Error("A valid skill selection is required.");
  return selected;
}
