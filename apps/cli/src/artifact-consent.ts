import {
  V2ArtifactConsentRequiredError,
  V2GitStateProvider,
} from "../../../packages/git-provider/src/index";
import { type CliIo, type CliOptions, isNonInteractive } from "./cli";

export type ArtifactConsentOptions = Readonly<{
  artifactChanges: readonly string[];
  allowArtifacts: boolean;
  nonInteractive: boolean;
}>;

export async function confirmGitArtifactWrite(
  options: ArtifactConsentOptions,
  ask: (question: string) => Promise<boolean> = askOnStdin,
): Promise<void> {
  if (options.artifactChanges.length === 0) return;
  if (options.nonInteractive) {
    if (!options.allowArtifacts) throw new V2ArtifactConsentRequiredError();
    return;
  }
  const accepted = await ask(
    "Exact local skill content will be committed to your Git repository. Continue?",
  );
  if (!accepted)
    throw new Error("Artifact commit cancelled; no Git changes were made.");
}

export function createCliV2GitStateProvider(
  input: Readonly<{
    storagePath: string;
    source: string;
    options: Pick<CliOptions, "allowArtifacts" | "nonInteractive">;
    io: CliIo;
    ask?: (question: string) => Promise<boolean>;
  }>,
): V2GitStateProvider {
  return new V2GitStateProvider(
    input.storagePath,
    input.source,
    undefined,
    (artifactChanges) =>
      confirmGitArtifactWrite(
        {
          artifactChanges,
          allowArtifacts: input.options.allowArtifacts,
          nonInteractive: isNonInteractive(input.options, input.io.stdinIsTTY),
        },
        input.ask,
      ),
  );
}

async function askOnStdin(question: string): Promise<boolean> {
  const { confirmOption } = await import("./prompts");
  return confirmOption(question, false);
}
