import { expect, test } from "bun:test";
import { type StateProvider, skillId } from "../../core/src/index";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  SaaSProvider,
  UNINITIALIZED_CLOUD_REVISION,
} from "./index";

const skill = skillId("sk_saas1");
const state = {
  manifest: {
    version: 1 as const,
    skills: [
      {
        id: skill,
        source: "https://github.com/example/skills.git",
        skill: "review",
        ref: "main",
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      },
    ],
  },
  lockfile: {
    version: 1 as const,
    skills: [
      {
        id: skill,
        source: "https://github.com/example/skills.git",
        skill: "review",
        ref: "main",
        repository: "https://github.com/example/skills.git",
        revision: "abc123",
        path: "skills/review",
        contentHash: "sha256:locked",
      },
    ],
  },
};

const transition = { type: "ADD" as const, skillId: skill, metadata: {} };

function provider(fetchImpl: typeof fetch, token = "device-token-secret") {
  return new SaaSProvider({
    origin: "https://toolmirror.com",
    workspaceId: "ws_1",
    deviceToken: token,
    fetch: fetchImpl,
  });
}

test("SaaSProvider exposes only portable pull/push state contracts", () => {
  const saas: StateProvider = provider(async () => new Response("{}"));
  expect(typeof saas.pull).toBe("function");
  expect(typeof saas.push).toBe("function");
  expect("login" in saas).toBe(false);
  expect("logout" in saas).toBe(false);
  expect("report" in saas).toBe(false);
  expect("pair" in saas).toBe(false);
});

test("Cloud origin must not include embedded credentials", () => {
  expect(
    () =>
      new SaaSProvider({
        origin: "https://user:secret@toolmirror.com",
        workspaceId: "ws_1",
        deviceToken: "token",
      }),
  ).toThrow("Cloud origin must not include credentials.");
});

test("pull authenticates with the device token and returns the current revision", async () => {
  const requests: Request[] = [];
  const result = await provider(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      revisionId: "rev_1",
      revisionSequence: 1,
      state,
    });
  }).pull();

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("GET");
  expect(requests[0].url).toBe(
    "https://toolmirror.com/api/v1/workspaces/ws_1/state",
  );
  expect(requests[0].headers.get(DEVICE_TOKEN_HEADER)).toBe(
    "device-token-secret",
  );
  expect(requests[0].headers.get(CLI_VERSION_HEADER)).toBe("0.1.0");
  expect(requests[0].url).not.toContain("device-token-secret");
  expect(result).toEqual({
    kind: "success",
    value: { revisionId: "rev_1", revisionSequence: 1, state },
  });
});

test("an empty Cloud workspace pulls as a null revision without fabricating history", async () => {
  const result = await provider(async () =>
    Response.json({
      revisionId: null,
      revisionSequence: 0,
      state: {
        manifest: { version: 1, skills: [] },
        lockfile: { version: 1, skills: [] },
      },
    }),
  ).pull();
  expect(result).toMatchObject({
    kind: "success",
    value: {
      revisionId: UNINITIALIZED_CLOUD_REVISION,
      revisionSequence: 0,
    },
  });
});

test("push maps an uninitialized Cloud revision to a null base revision", async () => {
  const requests: Request[] = [];
  await provider(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      revisionId: "rev_1",
      revisionSequence: 1,
      state,
    });
  }).push(
    {
      state,
      baseRevision: UNINITIALIZED_CLOUD_REVISION,
      idempotencyKey: "key-empty",
    },
    transition,
  );
  expect(await requests[0].json()).toMatchObject({ baseRevision: null });
});

test("push sends base revision, idempotency, and transition", async () => {
  const requests: Request[] = [];
  const result = await provider(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      revisionId: "rev_2",
      revisionSequence: 2,
      state,
    });
  }).push(
    { state, baseRevision: "rev_1", idempotencyKey: "key-1" },
    transition,
  );

  expect(requests[0].method).toBe("PUT");
  expect(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER)).toBe("key-1");
  expect(requests[0].headers.get(DEVICE_TOKEN_HEADER)).toBe(
    "device-token-secret",
  );
  expect(await requests[0].json()).toEqual({
    state,
    baseRevision: "rev_1",
    idempotencyKey: "key-1",
    transition,
  });
  expect(result).toMatchObject({
    kind: "success",
    value: { revisionId: "rev_2", revisionSequence: 2 },
  });
});

test("stale Cloud revisions and missing device tokens map to domain failures", async () => {
  expect(
    await provider(async () => new Response("{}", { status: 409 })).push(
      { state, baseRevision: "rev_stale", idempotencyKey: "key" },
      transition,
    ),
  ).toMatchObject({ kind: "failure", error: { code: "CONFLICT" } });
  expect(
    await provider(async () => new Response("{}", { status: 401 })).pull(),
  ).toMatchObject({ kind: "failure", error: { code: "AUTH_REQUIRED" } });
});

test("push without a transition stays on the portable Result boundary", async () => {
  expect(
    await provider(async () => new Response("unused")).push({
      state,
      baseRevision: null,
    }),
  ).toEqual({
    kind: "failure",
    error: {
      code: "VALIDATION_ERROR",
      message: "A Cloud state mutation needs a transition.",
    },
  });
});
