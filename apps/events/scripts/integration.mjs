import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Reuse the installed Wrangler toolchain; no additional test dependencies.
const require = createRequire(
  realpathSync(
    new URL("../../web/node_modules/wrangler/package.json", import.meta.url),
  ),
);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const WebSocket = createRequire(require.resolve("miniflare"))("ws");
const bundle = async (entry) =>
  (
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:workers"],
    })
  ).outputFiles[0].text;

const harness = `export default {
  async fetch(request, env) {
    const {pathname, searchParams: q} = new URL(request.url);
    const w = q.get('w') || 'workspace';
    const d = q.get('d') || 'device';
    if (pathname === '/subscribe') return env.EVENTS.fetch(new Request('https://events.internal/subscribe', {headers: {
      Upgrade: 'websocket', 'x-corotum-workspace-id': w, 'x-corotum-device-id': d,
      'x-corotum-token-id': q.get('t') || 'token', 'x-corotum-expires-at': q.get('expiry') || String(Date.now()+3590000)
    }}));
    if (pathname === '/publish') { await env.EVENTS.publish(await request.json(), q.get('deny') ? [] : ['token']); return new Response('ok'); }
    if (pathname === '/device') await env.EVENTS.invalidateDevice(w,d);
    if (pathname === '/workspace') await env.EVENTS.invalidateWorkspace(w);
    if (pathname === '/user') await env.EVENTS.invalidateUser(await request.json());
    const stub = env.STATE.get(env.STATE.idFromName(w));
    if (pathname === '/inspect') return Response.json(await stub.inspect());
    if (pathname === '/instance') return Response.json(await stub.instance());
    if (pathname === '/expire') await stub.expire();
    return new Response('ok');
  }
}`;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "harness",
        modules: true,
        script: harness,
        compatibilityDate: "2026-08-28",
        serviceBindings: { EVENTS: "events" },
        durableObjects: {
          STATE: {
            className: "TestWorkspaceEvents",
            scriptName: "events",
            unsafePreventEviction: false,
          },
        },
      },
      {
        name: "events",
        modules: true,
        script: await bundle("./fixture.ts"),
        compatibilityDate: "2026-08-28",
        durableObjects: {
          WORKSPACES: {
            className: "TestWorkspaceEvents",
            useSQLite: true,
            unsafePreventEviction: false,
          },
        },
      },
      {
        name: "production",
        modules: true,
        script: await bundle("../src/index.ts"),
        compatibilityDate: "2026-08-28",
        durableObjects: {
          WORKSPACES: { className: "WorkspaceEvents", useSQLite: true },
        },
      },
    ],
  }),
);
const call = (path, body) =>
  mf.dispatchFetch(
    `http://test${path}`,
    body === undefined
      ? { headers: { Upgrade: "websocket" } }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        },
  );
const sockets = [];
async function connect(query = "") {
  const url = new URL(`/subscribe${query}`, await mf.ready);
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  await next(socket, "open");
  sockets.push(socket);
  return socket;
}
function next(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for ${type}; state=${socket.readyState}`,
          ),
        ),
      5000,
    );
    // Miniflare's Node proxy may leave TCP half-closed after the actual server
    // close frame. Assert that frame directly, then release the test transport.
    if (type === "close") {
      socket._receiver.once("conclude", (code) => {
        clearTimeout(timer);
        resolve({ code });
        socket.terminate();
      });
      return;
    }
    socket.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}
const publish = (revisionSequence, workspaceId = "workspace") =>
  call("/publish", {
    workspaceId,
    revisionSequence,
    revisionId: `revision-${revisionSequence}`,
    secret: "must not leak",
  });
try {
  const production = await mf.getWorker("production");
  assert.equal(
    (await production.fetch("http://external/subscribe")).status,
    404,
  );
  assert.equal(
    (await production.fetch("https://events.internal/subscribe")).status,
    426,
  );
  const a = await connect("?t=token");
  const b = await connect("?d=other&t=token");
  const isolated = await connect("?w=isolated");
  const received = [];
  a.addEventListener("message", (event) =>
    received.push(JSON.parse(event.data)),
  );
  let message = next(a, "message");
  await publish(2);
  assert.deepEqual(JSON.parse((await message).data), {
    type: "revision.updated",
    workspaceId: "workspace",
    revisionSequence: 2,
    revisionId: "revision-2",
  });
  await publish(2);
  await publish(1);
  message = next(a, "message");
  await publish(3);
  await message;
  assert.deepEqual(
    received.map((event) => event.revisionSequence),
    [2, 3],
  );
  const attachments = await (await call("/inspect")).json();
  const attachment = attachments.find((entry) => entry.deviceId === "device");
  assert.equal(attachment.tokenId, "token");
  assert.equal(
    attachment.sequence,
    3,
    "dedup persisted in hibernation attachment",
  );
  assert.ok(attachment.expiresAt <= Date.now() + 3600000);
  const instanceBefore = await (await call("/instance")).json();
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  message = next(a, "message");
  await publish(4);
  assert.equal(JSON.parse((await message).data).revisionSequence, 4);
  const instanceAfter = await (await call("/instance")).json();
  assert.notEqual(
    instanceAfter,
    instanceBefore,
    "idle DO was evicted and reconstructed while sockets stayed connected",
  );
  assert.equal(
    (await (await call("/inspect")).json()).find((s) => s.deviceId === "device")
      .sequence,
    4,
  );
  console.log(
    "PASS actual workerd hibernation/constructor reconstruction with live sockets and restored attachments",
  );
  assert.deepEqual(
    await (await call("/inspect?w=isolated"))
      .json()
      .then((a) => a.map((s) => s.sequence)),
    [-1],
  );
  const closedA = next(a, "close");
  const revoked = await call("/device");
  assert.equal(revoked.status, 200, await revoked.text());
  assert.equal((await closedA).code, 1008);
  const closedB = next(b, "close");
  b.send("not allowed");
  assert.equal((await closedB).code, 1008);
  const expired = await connect("?w=expiry");
  const closedExpired = next(expired, "close");
  await call("/expire?w=expiry");
  await publish(1, "expiry");
  assert.equal((await closedExpired).code, 1008);
  const expiredMessage = await connect("?w=expiry-message");
  const closedExpiredMessage = next(expiredMessage, "close");
  await call("/expire?w=expiry-message");
  expiredMessage.send("message");
  assert.equal((await closedExpiredMessage).code, 1008);
  for (let i = 0; i < 4; i++) await connect("?w=cap");
  assert.equal((await call("/subscribe?w=cap")).status, 429);
  for (let i = 0; i < 256; i++) await connect(`?w=workspace-cap&d=d${i}`);
  assert.equal((await call("/subscribe?w=workspace-cap&d=extra")).status, 429);
  const isolatedClosed = next(isolated, "close");
  await call("/user", ["isolated", "cap", "workspace-cap"]);
  assert.equal((await isolatedClosed).code, 1008);
  const whole = await connect("?w=whole");
  const wholeClosed = next(whole, "close");
  await call("/workspace?w=whole");
  assert.equal((await wholeClosed).code, 1008);
  const race = await connect("?w=revoke-race");
  const raceClosed = next(race, "close");
  await call("/publish?deny=1", {
    workspaceId: "revoke-race",
    revisionSequence: 1,
    revisionId: "r1",
  });
  assert.equal(
    (await raceClosed).code,
    1008,
    "authoritative publish allowlist handles a missed revocation invalidation",
  );
  assert.equal((await publish(-1)).status, 500, "invalid sequence rejected");
  assert.equal(
    (
      await call("/publish", {
        workspaceId: "workspace",
        revisionSequence: 4,
        revisionId: "x".repeat(129),
      })
    ).status,
    500,
  );
  console.log(
    "PASS real workerd DO fanout, isolation, attachment dedup/expiry, RPC revocation, message rejection, both caps, input validation, public fetch rejection",
  );
} finally {
  for (const socket of sockets) {
    try {
      socket.terminate();
    } catch {}
  }
  await mf.dispose();
}
