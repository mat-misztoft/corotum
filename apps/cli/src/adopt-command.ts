import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import {
  type AgentId,
  builtInAgentAdapters,
} from "../../../packages/agent-targets/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import {
  GitSkillMaterializer,
  normalizeGitSource,
} from "../../../packages/skills-adapter/src/git-source";
import {
  AdoptService,
  type LocalAdoptCandidate,
  type RepositoryAdoptCandidate,
} from "./adopt";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";

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
            throw new Error("Run corotum init before adopting Git skills.");
          const storage = effectiveStoragePaths(config, paths);
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
          const resolved = await materializer.resolve({
            id: "pending-adopt" as never,
            source,
            skill: repository.name,
            ref: options.ref,
            path: repository.path,
          });
          const replaceLocalMismatch =
            resolved.contentHash === local.contentHash ||
            (nonInteractive
              ? false
              : await confirm(
                  `Repository content for ${name} differs. Replace this local copy with the locked repository version? [y/N] `,
                ));
          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
          const result = await new AdoptService(
            provider,
            new LocalReconcileExecutor(
              stateStore,
              new CanonicalSkillStore(storage.skillsStoragePath),
              materializer,
            ),
          ).adopt({
            source,
            local,
            repository,
            ref: options.ref,
            resolved,
            replaceLocalMismatch,
            execution: {
              enabledAgentIds: Object.entries(config.agents)
                .filter(([, value]) => value.enabled)
                .map(([id]) => id) as AgentId[],
              homeDir,
              state: (await stateStore.load()) ?? {
                schemaVersion: 1,
                lastAppliedRevision: null,
                skills: {},
              },
            },
          });
          if (result.kind === "refused") throw new Error(result.reason);
          const output = {
            outcome: "SUCCESS",
            status: "ADOPTED",
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
      },
    );
}

export async function selectLocalCandidate(
  candidates: readonly LocalAdoptCandidate[],
  nonInteractive: boolean,
): Promise<LocalAdoptCandidate> {
  if (candidates.length === 0)
    throw new Error(
      "No unmanaged local skill with that name was found in an enabled agent directory.",
    );
  if (candidates.length === 1) return candidates[0];
  if (nonInteractive)
    throw new Error(
      "Multiple local copies match; use an interactive terminal to select the copy to adopt.",
    );
  return selectCandidate(
    "Choose a local copy to adopt",
    candidates,
    (candidate) => `${candidate.agentId} (${candidate.path})`,
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
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const choices = candidates
      .map((candidate, index) => `${index + 1}) ${label(candidate)}`)
      .join("\n");
    const answer = (
      await prompt.question(`${title}:\n${choices}\n[1-${candidates.length}] `)
    ).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || !candidates[index])
      throw new Error("A valid skill selection is required.");
    return candidates[index];
  } finally {
    prompt.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return /^(y|yes)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

async function discoverLocalCandidates(
  homeDir: string,
  agents: Record<string, { enabled: boolean }>,
  name: string,
): Promise<LocalAdoptCandidate[]> {
  const candidates: LocalAdoptCandidate[] = [];
  for (const adapter of builtInAgentAdapters) {
    if (!agents[adapter.id]?.enabled) continue;
    for (const directory of adapter.globalSkillPaths(homeDir)) {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name !== name) continue;
          const path = join(directory, entry.name);
          candidates.push({
            agentId: adapter.id,
            name,
            path,
            contentHash: await hashSkillDirectory(path),
          });
        }
      } catch {}
    }
  }
  return candidates;
}
