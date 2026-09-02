import { describe, expect, test } from "bun:test";

import { agentStatuses, formatAgentStatuses, parseAgentId } from "./agents";

describe("agents helpers", () => {
  test("rejects unknown agent ids without treating agents as required", () => {
    expect(() => parseAgentId("codex")).not.toThrow();
    expect(() => parseAgentId("not-an-agent")).toThrow(/Supported agents/);
  });

  test("scan-shaped status reports detection without enabling", () => {
    const statuses = agentStatuses(["codex"], { pi: { enabled: false } });
    expect(statuses.find((agent) => agent.id === "codex")).toMatchObject({
      detected: true,
      enabled: false,
    });
    expect(statuses.find((agent) => agent.id === "pi")).toMatchObject({
      detected: false,
      enabled: false,
    });
    expect(formatAgentStatuses(statuses)).toContain(
      "Zero enabled agents is valid",
    );
  });
});
