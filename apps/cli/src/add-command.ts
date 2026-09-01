import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import type { SourceLock } from "../../../packages/core/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import {
  GitSkillMaterializer,
  normalizeGitSource,
} from "../../../packages/skills-adapter/src/git-source";
import type { AddCandidate } from "./add";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { V2LocalApplier } from "./v2-local-applier";
import { V2MutationService } from "./v2-mutations";

/** Registers Git-backed skill addition. Cloud add is intentionally deferred. */
export function registerAddCommand(program: Command, io: CliIo): void {
  program
    .command("add <source>")
    .description("resolve and add one skill from a Git source")
    .option("--skill <name>", "skill name to add")
    .option("--ref <ref>", "branch, tag, or commit to lock", "HEAD")
    .action(
      async (sourceInput: string, options: { skill?: string; ref: string }) => {
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
            throw new Error("Run corotum init before adding Git skills.");
          const source = normalizeGitSource(sourceInput);
          const materializer = new GitSkillMaterializer();
          const candidates = await materializer.discover(source, options.ref);
          const candidate = await selectCandidate(
            candidates,
            options.skill,
            program.opts<{ nonInteractive?: boolean }>().nonInteractive ===
              true || !io.stdinIsTTY,
          );
          const storage = effectiveStoragePaths(config, paths);
          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
          const service = new V2MutationService(
            createCliV2GitStateProvider({ storagePath: storage.gitStoragePath, source: config.gitRepository, options: program.opts(), io }),
            { resolve: async (metadata): Promise<SourceLock> => {
              const resolved = await materializer.resolve({ id: "pending-add" as never, source: metadata.repository, skill: candidate.name, ref: metadata.ref, path: metadata.path });
              return { ...resolved, ref: metadata.ref, contentHash: resolved.contentHash as `sha256:${string}` };
            } },
            new V2LocalApplier(stateStore, new CanonicalSkillStore(storage.skillsStoragePath), {
              storagePath: storage.gitStoragePath, repository: config.gitRepository,
              enabledAgentIds: Object.entries(config.agents).filter(([, value]) => value.enabled).map(([id]) => id) as AgentId[], homeDir,
            }),
          );
          const result = await service.add({ name: candidate.name, source: { repository: source, path: candidate.path, ref: options.ref } });
          if (result.kind === "refused") throw new Error(result.reason);
          if (result.kind === "duplicate") {
            writeResult(io, program.opts<{ json?: boolean }>().json === true, { outcome: "SUCCESS", status: "DUPLICATE", skillId: result.skillId });
            return;
          }
          if (result.kind === "source-unavailable") throw new Error(result.reason);
          writeResult(io, program.opts<{ json?: boolean }>().json === true, {
            outcome: result.kind === "persisted-not-applied" ? "PARTIAL_SUCCESS" : "SUCCESS",
            status: result.kind === "persisted-not-applied" ? "PERSISTED_NOT_APPLIED" : "ADDED",
            skill: candidate.name, skillId: result.skillId, revision: result.revision,
          });
        } finally {
          await release();
        }
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

  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const choices = matches
      .map(
        (candidate, index) =>
          `${index + 1}) ${candidate.name} (${candidate.path})`,
      )
      .join("\n");
    const answer = (
      await prompt.question(
        `Choose a skill:\n${choices}\n[1-${matches.length}] `,
      )
    ).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || !matches[index])
      throw new Error("A valid skill selection is required.");
    return matches[index];
  } finally {
    prompt.close();
  }
}
