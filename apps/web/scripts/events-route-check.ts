import { expect, mock } from "bun:test";
import { e2eDb } from "../e2e/harness";
import { approvePairing, createPairing } from "../src/pairings";
import { issueDeviceToken } from "../src/tokens";

const { sqlite, db } = await e2eDb();
const pairing = await createPairing(db, {
  name: "route-test",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
});
await approvePairing(db, "user_1", pairing.id, pairing.userCode);
const issued = await issueDeviceToken(db, pairing.id, pairing.deviceCode);
const published: unknown[] = [];
const subscribers: unknown[] = [];
const invalidated: unknown[] = [];
const limiter = {
  async limit() {
    return { success: true };
  },
};
mock.module("cloudflare:workers", () => ({
  env: {
    DB: db,
    COROTUM_HOSTED: "false",
    CLOUD_READ_LIMITER: limiter,
    CLOUD_WRITE_LIMITER: limiter,
    CLOUD_AUTH_LIMITER: limiter,
    EVENTS: {
      async publish(...args: unknown[]) {
        published.push(args);
      },
      async fetch(request: Request) {
        subscribers.push(Object.fromEntries(request.headers));
        return new Response("subscribed");
      },
      async invalidateDevice(...args: unknown[]) {
        invalidated.push(args);
      },
    },
  },
}));
const revision = await import("../app/api/v2/workspaces/[id]/revision/route");
const events = await import("../app/api/v2/workspaces/[id]/events/route");
const state = await import("../app/api/v1/workspaces/[id]/state/route");
const logout = await import("../app/api/v1/cli/logout/route");
const context = { params: Promise.resolve({ id: issued.workspaceId! }) };
const server = Bun.serve({
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === `/api/v2/workspaces/${issued.workspaceId}/revision`)
      return (await revision.GET(request, context))!;
    if (path === `/api/v2/workspaces/${issued.workspaceId}/events`)
      return (await events.GET(request, context))!;
    if (path === `/api/v1/workspaces/${issued.workspaceId}/state`)
      return (await state.PUT(request, context))!;
    if (path === "/api/v1/cli/logout") return (await logout.POST(request))!;
    return new Response("Not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const headers = {
  "x-toolmirror-device-token": issued.token,
  "x-toolmirror-cli-version": "0.1.0",
};
try {
  const path = `/api/v2/workspaces/${issued.workspaceId}`;
  expect(
    (
      await fetch(`${origin}${path}/revision`, {
        headers: { "x-toolmirror-cli-version": "0.1.0" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await (
      await fetch(`${origin}${path}/revision`, { headers })
    ).json()) as unknown,
  ).toEqual({ revisionId: null, revisionSequence: 0 });
  expect(
    (
      await fetch(`${origin}${path}/events`, {
        headers: { ...headers, upgrade: "websocket" },
      })
    ).status,
  ).toBe(200);
  expect(subscribers[0]).toMatchObject({
    "x-corotum-workspace-id": issued.workspaceId,
    "x-corotum-device-id": issued.deviceId,
    "x-corotum-token-id": expect.stringContaining("tok_"),
  });
  expect(JSON.stringify(subscribers)).not.toContain(issued.token);
  const body = {
    baseRevision: null,
    idempotencyKey: "route-mutation",
    state: {
      manifest: { version: 1, skills: [] },
      lockfile: { version: 1, skills: [] },
    },
    transition: { type: "REMOVE", skillId: "sk_01JRouteTest", metadata: {} },
  };
  const write = await fetch(
    `${origin}/api/v1/workspaces/${issued.workspaceId}/state`,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(write.status).toBe(200);
  expect(published).toHaveLength(1);
  const result = (await write.json()) as { revisionId: string };
  expect((published[0] as unknown[])[0]).toMatchObject({
    workspaceId: issued.workspaceId,
    revisionId: result.revisionId,
    revisionSequence: 1,
  });
  expect(
    (await fetch(`${origin}/api/v1/cli/logout`, { method: "POST", headers }))
      .status,
  ).toBe(200);
  expect(invalidated).toEqual([[issued.workspaceId, issued.deviceId]]);
  expect((await fetch(`${origin}${path}/revision`, { headers })).status).toBe(
    401,
  );
  expect(
    (
      await fetch(`${origin}${path}/events`, {
        headers: { ...headers, upgrade: "websocket" },
      })
    ).status,
  ).toBe(401);
  console.log("Actual route HTTP integration: PASS");
} finally {
  server.stop(true);
  sqlite.close();
}
