import {
  type AgentId,
  builtInAgentAdapters,
  builtInAgentIds,
} from "../../../packages/agent-targets/src/index";

export type AgentStatus = Readonly<{
  id: AgentId;
  name: string;
  detected: boolean;
  enabled: boolean;
}>;

export function parseAgentId(value: string): AgentId {
  if ((builtInAgentIds as readonly string[]).includes(value)) {
    return value as AgentId;
  }
  throw new Error(
    `Unknown agent "${value}". Supported agents: ${builtInAgentIds.join(", ")}.`,
  );
}

export function agentStatuses(
  detectedIds: readonly AgentId[],
  configured: Readonly<Record<string, { enabled: boolean }>>,
): readonly AgentStatus[] {
  const detected = new Set(detectedIds);
  return builtInAgentAdapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    detected: detected.has(adapter.id),
    enabled: configured[adapter.id]?.enabled === true,
  }));
}

export function formatAgentStatuses(agents: readonly AgentStatus[]): string {
  return [
    "Agents are optional. Zero enabled agents is valid.",
    "",
    ...agents.map((agent) => {
      const mark = agent.detected ? "●" : "○";
      const detection = agent.detected ? "detected" : "not detected";
      const enabled = agent.enabled ? "enabled" : "disabled";
      return `  ${mark} ${agent.name} (${agent.id})  ${detection}  ${enabled}`;
    }),
    "",
  ].join("\n");
}

export function enabledAgentIdsFrom(
  configured: Readonly<Record<string, { enabled: boolean }>>,
): AgentId[] {
  return Object.entries(configured)
    .filter(([, value]) => value.enabled)
    .map(([id]) => id)
    .filter((id): id is AgentId =>
      (builtInAgentIds as readonly string[]).includes(id),
    );
}
