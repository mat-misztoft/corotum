import type { CliOutcome } from "./cli-contracts";
import type { ConfigStore } from "./config";

export const telemetryCommandNames = [
  "init",
  "add",
  "adopt",
  "remove",
  "unmanage",
  "restore",
  "update",
  "set-ref",
  "sync",
  "status",
  "diff",
  "config",
  "login",
  "logout",
] as const;

type TelemetryCommandName = (typeof telemetryCommandNames)[number];

/** The complete anonymous event contract. */
export type TelemetryEvent = Readonly<{
  installationId: string;
  version: string;
  os: string;
  architecture: string;
  command: TelemetryCommandName;
  durationMs: number;
  outcome: CliOutcome;
  errorCode: CliOutcome | null;
  activeAgentCount: number;
  supportedAgentIds: readonly string[];
}>;

export type TelemetryEmitter = Readonly<{
  emit: (event: TelemetryEvent) => Promise<void>;
}>;

export type TelemetryPrompt = Readonly<{
  confirm: () => Promise<boolean>;
}>;

type Clock = Readonly<{ now: () => number }>;

type Runtime = Readonly<{
  architecture: string;
  os: string;
  version: string;
}>;

type PendingEvent = Readonly<{
  command: TelemetryCommandName;
  startedAt: number;
}>;

/** Handles local consent and event construction without owning HTTP transport. */
export class CliTelemetry {
  constructor(
    private readonly configStore: Pick<ConfigStore, "load" | "set">,
    private readonly prompt: TelemetryPrompt,
    private readonly emitter: TelemetryEmitter,
    private readonly runtime: Runtime,
    private readonly clock: Clock = { now: Date.now },
  ) {}

  async begin(
    argv: readonly string[],
    interactive: boolean,
  ): Promise<PendingEvent | null> {
    const command = commandFrom(argv);
    if (!command) return null;

    let config = await this.configStore.load();
    if (config.telemetry === null) {
      if (!interactive) return null;
      const accepted = await this.prompt.confirm();
      await this.configStore.set("telemetry", accepted);
      if (!accepted) return null;
      config = await this.configStore.load();
    }
    if (!config.telemetry) return null;

    if (!config.installationId) {
      await this.configStore.set("installationId", crypto.randomUUID());
    }
    return { command, startedAt: this.clock.now() };
  }

  async finish(
    pending: PendingEvent | null,
    outcome: CliOutcome,
  ): Promise<void> {
    if (!pending) return;
    const config = await this.configStore.load();
    if (!config.telemetry || !config.installationId) return;

    try {
      await this.emitter.emit({
        installationId: config.installationId,
        version: this.runtime.version,
        os: this.runtime.os,
        architecture: this.runtime.architecture,
        command: pending.command,
        durationMs: Math.max(0, this.clock.now() - pending.startedAt),
        outcome,
        errorCode: outcome === "SUCCESS" ? null : outcome,
        activeAgentCount: Object.values(config.agents).filter(
          (agent) => agent.enabled,
        ).length,
        supportedAgentIds: Object.keys(config.agents).sort(),
      });
    } catch {
      // Telemetry is optional: delivery failures must never change CLI results.
    }
  }
}

/** Help and version paths never start telemetry or first-run consent. */
export function isHelpOrVersionArgv(argv: readonly string[]): boolean {
  return argv.some((argument) =>
    ["--help", "-h", "--version", "-V"].includes(argument),
  );
}

function commandFrom(argv: readonly string[]): TelemetryCommandName | null {
  if (isHelpOrVersionArgv(argv)) return null;
  for (const argument of argv) {
    if (argument.startsWith("-")) continue;
    return (telemetryCommandNames as readonly string[]).includes(argument)
      ? (argument as TelemetryCommandName)
      : null;
  }
  return null;
}

export function noOpTelemetryEmitter(): TelemetryEmitter {
  return { emit: async () => undefined };
}
