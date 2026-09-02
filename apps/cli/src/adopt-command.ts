import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import {
  type AgentId,
  builtInAgentAdapters,
} from "../../../packages/agent-targets/src/index";
import type { SourceLock } from "../../../packages/core/src/index";
import { gitTreeHash } from "../../../packages/git-provider/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import {
  GitSkillMaterializer,
  normalizeGitSource,
} from "../../../packages/skills-adapter/src/git-source";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import type { RepositoryAdoptCandidate } from "./adopt";
import { createCliV2GitStateProvider } from "./artifact-consent";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import {
  assertGitAvailable,
  notInitializedError,
  withGitCliErrors,
} from "./init-errors";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { selectOption } from "./prompts";
import { V2LocalApplier } from "./v2-local-applier";
import { V2MutationService } from "./v2-mutations";

type CliAdoptCandidate = Readonly<{
  agentId: AgentId | null;
  contentHash: string;
  name: string;
  path: string;
}>;

/** Registers safe adoption of one existing unmanaged copy from a Git source. */
export function registerAdoptCommand(program: Command, io: CliIo): void {
  program
    .command("adopt <name>")
    .description("adopt one local skill from a matching Git source")
    .requiredOption("--source <repository>", "Git source containing the skill")
    .option(
      "--skill <name>",
      "source skill name when it differs from the local name",
    )
    .option("--ref <ref>", "branch, tag, or commit to lock", "HEAD")
    .action(
      async (
        name: string,
        options: { source: string; skill?: string; ref: string },
      ) => {
        await withGitCliErrors(async () => {
        const homeDir = homedir();
        const paths = resolvePlatformPaths({
          homeDir,
          platform: process.platform as "darwin" | "linux" | "win32",
          env: process.env,
        });
        await assertGitAvailable();
        const release = await new MutationLock(
          join(paths.stateDir, "process.lock"),
        ).acquire();
        try {
          const config = await new ConfigStore(paths).load();
          if (config.mode !== "git" || !config.gitRepository)
            throw notInitializedError("adopting Git skills");
          const storage = effectiveStoragePaths(config, paths);
          const nonInteractive =
            program.opts<{ nonInteractive?: boolean }>().nonInteractive ===
              true || !io.stdinIsTTY;
          const local = await selectLocalCandidate(
            await discoverLocalCandidates(homeDir, config.agents, name),
            nonInteractive,
          );
          const source = normalizeGitSource(options.source);
          const materializer = new GitSkillMaterializer();
          const repository = await selectRepositoryCandidate(
            await materializer.discover(source, options.ref),
            options.skill ?? name,
            nonInteractive,
          );
          const scanned = await scanNormalizedContent(local.path);
          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
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
                  id: "pending-adopt" as never,
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
          ).adoptArtifact({
            name: repository.name,
            artifactDirectory: local.path,
            contentHash: scanned.contentHash,
            integrityHash: await gitTreeHash(local.path),
            sizeBytes: scanned.files.reduce((size, file) => size + file.content.length, 0),
            source: { repository: source, path: repository.path, ref: options.ref },
            targets: local.agentId ? [local.agentId] : "all",
          });
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
                : "ADOPTED",
            skill: repository.name,
            skillId: result.skillId,
            revision: result.revision,
          };
          if (program.opts<{ json?: boolean }>().json)
            io.writeOutput(`${JSON.stringify(jsonEnvelope(output))}\n`);
          else
            io.writeOutput(
              `Adopted ${repository.name} at revision ${result.revision}.\n`,
            );
        } finally {
          await release();
        }
        });
      },
    );
}

export async function selectLocalCandidate(
  candidates: readonly CliAdoptCandidate[],
  nonInteractive: boolean,
): Promise<CliAdoptCandidate> {
  if (candidates.length === 0)
    throw new Error(
      "No unmanaged local skill with that name was found in ~/.agents/skills or an enabled agent directory.",
    );
  if (candidates.length === 1) return candidates[0];
  if (nonInteractive)
    throw new Error(
      "Multiple local copies match; use an interactive terminal to select the copy to adopt.",
    );
  return selectCandidate(
    "Choose a local copy to adopt",
    candidates,
    (candidate) => `${candidate.agentId ?? "global"} (${candidate.path})`,
  );
}

export async function selectRepositoryCandidate(
  candidates: readonly RepositoryAdoptCandidate[],
  name: string,
  nonInteractive: boolean,
): Promise<RepositoryAdoptCandidate> {
  const matches = candidates.filter((candidate) => candidate.name === name);
  if (matches.length === 0)
    throw new Error(`Skill ${name} was not found in this source.`);
  if (matches.length === 1) return matches[0];
  if (nonInteractive)
    throw new Error(
      `Skill ${name} is ambiguous in this source; use an interactive terminal to select its path.`,
    );
  return selectCandidate(
    "Choose a source skill",
    matches,
    (candidate) => candidate.path,
  );
}

async function selectCandidate<T>(
  title: string,
  candidates: readonly T[],
  label: (candidate: T) => string,
): Promise<T> {
  const index = await selectOption(
    title,
    candidates.map((candidate, position) => ({
      value: String(position),
      label: label(candidate),
    })),
  );
  const selected = candidates[Number(index)];
  if (!selected) throw new Error("A valid skill selection is required.");
  return selected;
}

async function discoverLocalCandidates(
  homeDir: string,
  agents: Record<string, { enabled: boolean }>,
  name: string,
): Promise<CliAdoptCandidate[]> {
  const candidates: CliAdoptCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = async (
    agentId: CliAdoptCandidate["agentId"],
    directory: string,
  ): Promise<void> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name !== name) continue;
        const path = join(directory, entry.name);
        if (seen.has(path)) continue;
        seen.add(path);
        candidates.push({
          agentId,
          name,
          path,
          contentHash: await hashSkillDirectory(path),
        });
      }
    } catch {}
  };
  await addCandidate(null, join(homeDir, ".agents", "skills"));
  for (const adapter of builtInAgentAdapters) {
    if (!agents[adapter.id]?.enabled) continue;
    for (const directory of adapter.globalSkillPaths(homeDir)) {
      await addCandidate(adapter.id, directory);
    }
  }
  return candidates;
}
