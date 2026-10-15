import { expect, test } from "bun:test";
import {
  AutoRateLimitError,
  autoCloudEndpoint,
  probeAutoCloud,
  RevisionEventGate,
  readAutoRevision,
  retryAfterMs,
} from "./auto-cloud";

test("automatic sync never sends device tokens to non-local plaintext origins", () => {
  const context = {
    origin: "http://corotum.com",
    workspaceId: "w",
    token: "secret",
    cliVersion: "0.8.0",
  };
  expect(() => autoCloudEndpoint(context)).toThrow("HTTPS");
  expect(() =>
    autoCloudEndpoint({ ...context, origin: "http://cloud.example.com" }),
  ).toThrow("HTTPS");
  expect(
    autoCloudEndpoint({ ...context, origin: "http://127.0.0.1:1234" }),
  ).toContain("127.0.0.1");
});

test("revision event contract validates workspace and monotonic sequence before scheduling", () => {
  const gate = new RevisionEventGate("w");
  const event = (overrides = {}) =>
    JSON.stringify({
      type: "revision.updated",
      workspaceId: "w",
      revisionId: "r2",
      revisionSequence: 2,
      ...overrides,
    });
  expect(gate.accepts(event())).toBe(true);
  expect(gate.accepts(event())).toBe(false);
  expect(gate.accepts(event({ revisionSequence: 1 }))).toBe(false);
  expect(
    gate.accepts(event({ workspaceId: "other", revisionSequence: 3 })),
  ).toBe(false);
  expect(gate.accepts(event({ type: "revision", revisionSequence: 3 }))).toBe(
    false,
  );
  expect(gate.accepts(event({ revisionSequence: 2.5 }))).toBe(false);
  expect(gate.accepts("not JSON")).toBe(false);
  gate.observe(10);
  expect(gate.accepts(event({ revisionSequence: 9 }))).toBe(false);
  expect(gate.accepts(event({ revisionSequence: 11 }))).toBe(true);
});

test("Retry-After accepts seconds or dates with safe bounds", () => {
  expect(retryAfterMs("120")).toBe(120_000);
  expect(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 0)).toBe(60_000);
  expect(retryAfterMs("0")).toBe(1000);
  expect(retryAfterMs("999999999")).toBe(3_600_000);
  expect(retryAfterMs("invalid")).toBe(60_000);
});

test("enable preflight proves authenticated metadata and real WS subscription; missing events fails", async () => {
  let available = true;
  let metadataStatus = 200;
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      expect(request.headers.get("x-toolmirror-device-token")).toBe(
        "private-token",
      );
      expect(request.headers.get("x-toolmirror-cli-version")).toBe("0.8.0");
      expect(new URL(request.url).search).toBe("");
      requests.push(new URL(request.url).pathname);
      if (request.url.endsWith("/revision"))
        return Response.json(
          { revisionId: "r", revisionSequence: 1 },
          { status: metadataStatus, headers: { "retry-after": "123" } },
        );
      if (!available) return new Response("Unavailable", { status: 503 });
      if (server.upgrade(request)) return undefined;
      return new Response("Bad upgrade", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    const context = {
      origin: `http://localhost:${server.port}`,
      workspaceId: "w",
      token: "private-token",
      cliVersion: "0.8.0",
    };
    await probeAutoCloud(context);
    expect(requests).toEqual([
      "/api/v2/workspaces/w/revision",
      "/api/v2/workspaces/w/events",
    ]);
    available = false;
    await expect(probeAutoCloud(context, 500)).rejects.toThrow(
      "events are unavailable",
    );
    metadataStatus = 401;
    await expect(probeAutoCloud(context)).rejects.toThrow(
      "authentication failed",
    );
    metadataStatus = 429;
    const error = await readAutoRevision(context).catch((error) => error);
    expect(error).toBeInstanceOf(AutoRateLimitError);
    expect(error.retryAfterMs).toBe(123_000);
  } finally {
    server.stop(true);
  }
});
