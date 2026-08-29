import { expect, test } from "bun:test";
import {
  type AnonymousTelemetryEvent,
  ingestAnonymousTelemetry,
  parseAnonymousTelemetryEvent,
} from "./telemetry";
import { handlePostTelemetry } from "./telemetry-http";

const validEvent: AnonymousTelemetryEvent = {
  installationId: "123e4567-e89b-42d3-a456-426614174000",
  version: "0.1.0",
  os: "darwin",
  architecture: "arm64",
  command: "sync",
  durationMs: 24,
  outcome: "SUCCESS",
  errorCode: null,
  activeAgentCount: 2,
  supportedAgentIds: ["codex", "pi"],
};

function rateLimitDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

test("anonymous allowlisted telemetry reaches Analytics Engine without Cloud identity fields", () => {
  const points: AnalyticsEngineDataPoint[] = [];
  ingestAnonymousTelemetry(
    { writeDataPoint: (point) => points.push(point ?? {}) },
    validEvent,
  );
  expect(points).toEqual([
    {
      indexes: [validEvent.installationId],
      blobs: [
        "0.1.0",
        "darwin",
        "arm64",
        "sync",
        "SUCCESS",
        "NONE",
        "codex,pi",
      ],
      doubles: [24, 2, 2],
    },
  ]);
  expect(JSON.stringify(points)).not.toContain("user");
  expect(JSON.stringify(points)).not.toContain("device");
});

test("telemetry parser rejects identifiers and unallowlisted data that could expose private data", () => {
  for (const unsafe of [
    { repositoryUrl: "https://github.com/acme/private" },
    { localPath: "/Users/ada/.pi/skills" },
    { skillName: "private-review" },
    { token: "secret-token" },
    { skillContent: "never upload this" },
  ]) {
    expect(
      parseAnonymousTelemetryEvent({ ...validEvent, ...unsafe }),
    ).toBeNull();
  }
  expect(
    parseAnonymousTelemetryEvent({
      ...validEvent,
      version: "https://example.com",
    }),
  ).toBeNull();
  expect(parseAnonymousTelemetryEvent({ ...validEvent, os: "Ada" })).toBeNull();
  expect(
    parseAnonymousTelemetryEvent({
      ...validEvent,
      supportedAgentIds: ["/home/ada/secret"],
    }),
  ).toBeNull();
});

test("telemetry transport accepts only compatible CLI allowlisted events", async () => {
  const points: AnalyticsEngineDataPoint[] = [];
  const analytics = {
    writeDataPoint: (point?: AnalyticsEngineDataPoint) =>
      points.push(point ?? {}),
  };
  const accepted = await handlePostTelemetry(
    new Request("https://toolmirror.com/api/v1/telemetry", {
      method: "POST",
      headers: { "x-toolmirror-cli-version": "0.1.0" },
      body: JSON.stringify(validEvent),
    }),
    rateLimitDb() as never,
    analytics,
  );
  expect(accepted.status).toBe(204);
  expect(points).toHaveLength(1);

  const rejected = await handlePostTelemetry(
    new Request("https://toolmirror.com/api/v1/telemetry", {
      method: "POST",
      headers: { "x-toolmirror-cli-version": "0.1.0" },
      body: JSON.stringify({
        ...validEvent,
        content: "private skill contents",
      }),
    }),
    rateLimitDb() as never,
    analytics,
  );
  expect(rejected.status).toBe(400);
  expect(points).toHaveLength(1);
});
