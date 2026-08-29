import { describe, expect, test } from "bun:test";

import type { ToolMirrorConfig } from "./config";
import { CliTelemetry, type TelemetryEvent } from "./telemetry";

function fixture(consent: boolean | null = null) {
  let config: ToolMirrorConfig = {
    schemaVersion: 1,
    mode: null,
    workspaceId: null,
    deviceId: null,
    skillsStoragePath: null,
    gitStoragePath: null,
    gitRepository: null,
    telemetry: consent,
    installationId: null,
    agents: { codex: { enabled: true }, pi: { enabled: false } },
  };
  const events: TelemetryEvent[] = [];
  let prompts = 0;
  let time = 10;
  const telemetry = new CliTelemetry(
    {
      load: async () => config,
      set: async (key, value) => {
        config = { ...config, [key]: value };
        return config;
      },
    },
    {
      confirm: async () => {
        prompts += 1;
        return true;
      },
    },
    { emit: async (event) => void events.push(event) },
    { version: "0.1.0", os: "linux", architecture: "x64" },
    { now: () => time++ },
  );
  return {
    telemetry,
    events,
    promptCount: () => prompts,
    config: () => config,
    setTelemetry: (value: boolean) => {
      config = { ...config, telemetry: value };
    },
  };
}

describe("CLI telemetry consent", () => {
  test("does not prompt or emit on a non-interactive first run", async () => {
    const subject = fixture();
    const pending = await subject.telemetry.begin(["status"], false);
    await subject.telemetry.finish(pending, "SUCCESS");

    expect(subject.promptCount()).toBe(0);
    expect(subject.events).toEqual([]);
    expect(subject.config().telemetry).toBeNull();
    expect(subject.config().installationId).toBeNull();
  });

  test("starts anonymous telemetry only after affirmative consent", async () => {
    const subject = fixture();
    const pending = await subject.telemetry.begin(["sync"], true);

    expect(subject.events).toEqual([]);
    expect(subject.promptCount()).toBe(1);
    expect(subject.config().telemetry).toBe(true);
    expect(subject.config().installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await subject.telemetry.finish(pending, "PARTIAL_SUCCESS");
    expect(subject.events).toEqual([
      expect.objectContaining({
        version: "0.1.0",
        os: "linux",
        architecture: "x64",
        command: "sync",
        outcome: "PARTIAL_SUCCESS",
        errorCode: "PARTIAL_SUCCESS",
        activeAgentCount: 1,
        supportedAgentIds: ["codex", "pi"],
      }),
    ]);
    expect(Object.keys(subject.events[0] ?? {}).sort()).toEqual([
      "activeAgentCount",
      "architecture",
      "command",
      "durationMs",
      "errorCode",
      "installationId",
      "os",
      "outcome",
      "supportedAgentIds",
      "version",
    ]);
  });

  test("honors later telemetry enablement and disablement", async () => {
    const subject = fixture(false);
    expect(await subject.telemetry.begin(["status"], false)).toBeNull();

    subject.setTelemetry(true);
    const pending = await subject.telemetry.begin(["status"], false);
    await subject.telemetry.finish(pending, "SUCCESS");
    expect(subject.events).toHaveLength(1);

    const disabledPending = await subject.telemetry.begin(["status"], false);
    subject.setTelemetry(false);
    await subject.telemetry.finish(disabledPending, "SUCCESS");
    expect(subject.events).toHaveLength(1);
  });

  test("does not let optional telemetry delivery alter a command", async () => {
    let config = fixture(true).config();
    const telemetry = new CliTelemetry(
      {
        load: async () => config,
        set: async (key, value) => {
          config = { ...config, [key]: value };
          return config;
        },
      },
      { confirm: async () => true },
      { emit: async () => Promise.reject(new Error("offline")) },
      { version: "0.1.0", os: "linux", architecture: "x64" },
    );
    await telemetry.finish(await telemetry.begin(["status"], false), "SUCCESS");
  });

  test("never treats arbitrary arguments as a telemetry command", async () => {
    const subject = fixture(true);
    expect(
      await subject.telemetry.begin(["private-skill-name"], true),
    ).toBeNull();
    expect(subject.events).toEqual([]);
  });
});
