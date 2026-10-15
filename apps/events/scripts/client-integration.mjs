import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(
  realpathSync(
    new URL("../../web/node_modules/wrangler/package.json", import.meta.url),
  ),
);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const bundle = async (file) =>
  (
    await build({
      entryPoints: [resolve(root, file)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      alias: { process: "node:process", buffer: "node:buffer" },
      external: ["cloudflare:workers", "node:*"],
    })
  ).outputFiles[0].text;
const temp = await mkdtemp(join(tmpdir(), "corotum-auto-real-"));
const binary = process.env.COROTUM_TEST_BINARY || join(temp, "corotum");
const children = new Set();
let mf;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
try {
  if (!process.env.COROTUM_TEST_BINARY)
    execFileSync(
      "bun",
      ["build", "apps/cli/src/index.ts", "--compile", "--outfile", binary],
      { cwd: root, stdio: "pipe" },
    );
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "web",
          modules: true,
          script: await bundle(
            process.env.COROTUM_TEST_BUILT_WEB
              ? "apps/events/scripts/built-client-fixture.ts"
              : "apps/events/scripts/client-fixture.ts",
          ),
          compatibilityDate: "2026-08-28",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          serviceBindings: { EVENTS: "events" },
          bindings: {
            COROTUM_HOSTED: "false",
            COROTUM_ENVIRONMENT: "development",
          },
          ratelimits: {
            CLOUD_READ_LIMITER: {
              simple: { limit: 1000, period: 60 },
              namespace_id: "1",
            },
            CLOUD_WRITE_LIMITER: {
              simple: { limit: 1000, period: 60 },
              namespace_id: "2",
            },
            CLOUD_AUTH_LIMITER: {
              simple: { limit: 1000, period: 60 },
              namespace_id: "3",
            },
          },
        },
        {
          name: "events",
          modules: true,
          script: await bundle("apps/events/src/index.ts"),
          compatibilityDate: "2026-08-28",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            WORKSPACES: { className: "WorkspaceEvents", useSQLite: true },
          },
        },
      ],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(join(root, "apps/web/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(join(root, "apps/web/migrations", file), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.prepare(statement).run();
  }
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      "user_test",
      "Integration",
      "integration@example.invalid",
      1,
      now,
      now,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO workspaces (id,owner_user_id,name,current_revision_sequence,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind("ws_test", "user_test", "Integration", 0, now, now)
    .run();
  const origin = (await mf.ready).origin;
  const homes = {};
  const tokens = {};
  for (const id of ["a", "b"]) {
    const token = `integration-${randomUUID()}`;
    tokens[id] = token;
    await db
      .prepare(
        "INSERT INTO devices (id,user_id,name,platform,architecture,cli_version,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        `dev_${id}`,
        "user_test",
        id,
        process.platform,
        process.arch,
        "0.8.0",
        now,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO device_tokens (id,device_id,token_hash,created_at) VALUES (?,?,?,?)",
      )
      .bind(
        `token_${id}`,
        `dev_${id}`,
        createHash("sha256").update(token).digest("hex"),
        now,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO device_workspaces (device_id,workspace_id,is_active) VALUES (?,?,1)",
      )
      .bind(`dev_${id}`, "ws_test")
      .run();
    const home = join(temp, id);
    homes[id] = home;
    const configDir =
      process.platform === "darwin"
        ? join(home, "Library/Application Support/Corotum")
        : join(home, ".config/corotum");
    homes[`${id}State`] =
      process.platform === "darwin"
        ? join(configDir, "state")
        : join(home, ".local/state/corotum");
    await json(join(configDir, "config.json"), {
      schemaVersion: 1,
      mode: "cloud",
      workspaceId: "ws_test",
      deviceId: `dev_${id}`,
      skillsStoragePath: join(home, "canonical"),
      gitStoragePath: join(home, "git"),
      gitRepository: null,
      telemetry: false,
      origin,
      installationId: null,
      agents: {},
      autoSync: { enabled: true },
    });
    await json(join(configDir, "credentials.json"), {
      schemaVersion: 1,
      cloudDeviceToken: token,
    });
  }
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN SELECT t.id FROM device_tokens t
    JOIN devices d ON d.id = t.device_id JOIN device_workspaces dw ON dw.device_id = d.id
    WHERE dw.workspace_id = ? AND dw.is_active = 1 AND d.user_id = ?
      AND d.revoked_at IS NULL AND t.revoked_at IS NULL`)
    .bind("ws_test", "user_test")
    .all();
  const details = plan.results.map((row) => row.detail).join("\n");
  assert.match(details, /device_workspaces_active_workspace_idx/);
  assert.match(details, /device_tokens_active_device_idx/);
  console.log(
    "PASS D1 broadcast authorization uses workspace/token indexes, not global membership/token scans",
  );
  const start = (id) => {
    const child = spawn(binary, ["--non-interactive", "auto", "run"], {
      env: {
        ...process.env,
        HOME: homes[id],
        COROTUM_CLOUD_ORIGIN: origin,
        XDG_CONFIG_HOME: join(homes[id], ".config"),
        XDG_STATE_HOME: join(homes[id], ".local/state"),
        XDG_DATA_HOME: join(homes[id], ".local/share"),
        XDG_RUNTIME_DIR: join(homes[id], "runtime"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    children.add(child);
    child.on("exit", () => children.delete(child));
    return child;
  };
  const status = async (id) =>
    JSON.parse(
      await readFile(join(homes[`${id}State`], "auto-status.json"), "utf8"),
    );
  const metrics = async () => (await fetch(`${origin}/test/metrics`)).json();
  if (process.env.COROTUM_TEST_BUILT_WEB) {
    const probe = await fetch(`${origin}/api/v2/workspaces/ws_test/revision`, {
      headers: {
        "x-toolmirror-device-token": tokens.a,
        "x-toolmirror-cli-version": "0.8.0",
      },
    });
    assert.equal(probe.status, 200, await probe.clone().text());
    const upgrade = await mf.dispatchFetch(
      `${origin}/api/v2/workspaces/ws_test/events`,
      {
        headers: {
          upgrade: "websocket",
          "x-toolmirror-device-token": tokens.a,
          "x-toolmirror-cli-version": "0.8.0",
        },
      },
    );
    assert.equal(upgrade.status, 101, await upgrade.text());
    assert.ok(
      upgrade.webSocket,
      "production vinext preserves the WebSocket upgrade",
    );
    upgrade.webSocket.accept();
    upgrade.webSocket.close();
  }
  start("a");
  let b = start("b");
  await until(
    async () =>
      (await status("a")).connection === "connected" &&
      (await status("b")).connection === "connected",
    "both authenticated sockets",
  );
  const repo = join(temp, "source");
  execFileSync("git", ["init", "--initial-branch=main", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Integration"]);
  await mkdir(join(repo, "demo"));
  await writeFile(join(repo, "demo/SKILL.md"), "# Automatic convergence\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "skill"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const contentHash = execFileSync(
    "bun",
    [
      "-e",
      `import {scanNormalizedContent} from './packages/skills-adapter/src/normalized-content.ts'; console.log((await scanNormalizedContent(${JSON.stringify(join(repo, "demo"))})).contentHash)`,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const source = {
    repository: repo,
    path: "demo",
    ref: "main",
    revision,
    contentHash,
  };
  const skill = {
    id: "sk_demo",
    name: "demo",
    targets: "all",
    source: { repository: repo, path: "demo", ref: "main" },
    resolutionStatus: "RESOLVED",
  };
  const desired = {
    manifest: { version: 2, skills: [skill] },
    lockfile: {
      version: 2,
      skills: [
        {
          id: "sk_demo",
          name: "demo",
          source,
          materialization: { kind: "source", contentHash },
        },
      ],
    },
  };
  let head = null;
  async function commit(state) {
    const activeDispositions = state.manifest.skills.length
      ? {}
      : {
          sk_demo: {
            skillId: "sk_demo",
            name: "demo",
            disposition: "REMOVE",
            effectiveSequence: 2,
          },
        };
    const response = await fetch(`${origin}/test/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: head,
        idempotencyKey: randomUUID(),
        state,
        transition: { type: "UPDATE", skillId: "sk_demo", metadata: {} },
        dispositionLedger: { version: 2, activeDispositions },
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    head = result.id;
    return result;
  }
  const changed = Date.now();
  await commit(desired);
  await until(
    async () =>
      (await status("a")).appliedRevision === head &&
      (await status("b")).appliedRevision === head,
    "both compiled clients apply revision",
  );
  assert.equal(
    await readFile(join(homes.a, "canonical/demo/SKILL.md"), "utf8"),
    "# Automatic convergence\n",
  );
  assert.equal(
    await readFile(join(homes.b, "canonical/demo/SKILL.md"), "utf8"),
    "# Automatic convergence\n",
  );
  console.log(
    `PASS two compiled clients automatic Git-backed install via real authenticated workerd WebSockets (${Date.now() - changed}ms observed)`,
  );
  const before = await metrics();
  const sample = () =>
    process.platform === "darwin"
      ? execFileSync(
          "ps",
          [
            "-o",
            "pid=,time=,rss=",
            "-p",
            [...children].map((child) => child.pid).join(","),
          ],
          { encoding: "utf8" },
        ).trim()
      : null;
  const cpuBefore = sample();
  await sleep(2500);
  const after = await metrics();
  assert.deepEqual(
    after,
    before,
    "idle produces no state downloads/reports/revision checks",
  );
  if (cpuBefore)
    console.log(
      "OBSERVED macOS ps (PID, cumulative CPU time, RSS KiB), before/after 2.5s idle:",
      cpuBefore,
      "/",
      sample(),
    );
  await fetch(`${origin}/test/disconnect`);
  await until(
    async () =>
      (await metrics()).revision > after.revision &&
      (await status("a")).connection === "connected",
    "unexpected socket disconnect recovers",
  );
  const reconnected = await metrics();
  assert.equal(
    reconnected.state,
    after.state,
    "unchanged reconnect does not download state",
  );
  assert.equal(
    reconnected.reports,
    after.reports,
    "unchanged reconnect does not report",
  );
  console.log(
    "PASS real socket reconnection and revision-only recovery without a full sync",
  );
  b.kill("SIGTERM");
  await new Promise((r) => b.once("exit", r));
  const empty = {
    manifest: { version: 2, skills: [] },
    lockfile: { version: 2, skills: [] },
  };
  await commit(empty);
  await until(
    async () => (await status("a")).appliedRevision === head,
    "online update",
  );
  b = start("b");
  await until(
    async () => (await status("b")).appliedRevision === head,
    "offline reconnect recovery",
  );
  console.log(
    "PASS offline compiled-client recovery; verified revision convergence; idle no-download/no-report checks",
    after,
  );
  await db
    .prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = 'token_b'")
    .bind(Date.now())
    .run();
  await commit(desired);
  await until(
    async () =>
      (await status("a")).appliedRevision === head &&
      (await status("b")).lastErrorCode === "AUTH_REQUIRED",
    "revocation excludes delivery and blocks credentials",
  );
  const denied = await fetch(`${origin}/api/v1/workspaces/ws_test/state`, {
    headers: {
      "x-toolmirror-device-token": tokens.b,
      "x-toolmirror-cli-version": "0.8.0",
    },
  });
  assert.equal(denied.status, 401);
  assert.notEqual((await status("b")).appliedRevision, head);
  console.log(
    "PASS revoked compiled client excluded without explicit invalidation; protected state denies token",
  );
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((r) => {
          child.once("exit", r);
          setTimeout(() => {
            child.kill("SIGKILL");
            r();
          }, 5000).unref();
        }),
    ),
  );
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
