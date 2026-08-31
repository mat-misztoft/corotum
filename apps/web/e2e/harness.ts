import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReleaseLayout,
  type LatestJson,
  RELEASE_TARGETS,
  type ReleaseTarget,
  type ReleaseTargetId,
} from "../../../tooling/release";
import type { BillingEnvironment, CreemClient } from "../src/billing";
import { handleBillingCheckout, handleCreemWebhook } from "../src/billing-http";
import { CLI_VERSION_HEADER } from "../src/cli-compat";
import { handleDashboardGet } from "../src/dashboard-http";
import { handleDashboardSettingsGet } from "../src/dashboard-settings";
import { handleGetDeviceTargetStatus } from "../src/device-target-status-http";
import {
  handleApprovePairing,
  handleCreatePairing,
  handleGetPairing,
} from "../src/pairings-http";
import {
  handleGetWorkspaceState,
  handlePostPendingResolution,
  handlePutWorkspaceState,
} from "../src/state-http";
import { handlePostDeviceSyncReport } from "../src/sync-report-http";
import type { TokenDatabase } from "../src/tokens";
import { handleIssueDeviceToken, handleLogoutDevice } from "../src/tokens-http";
import { handleWebMcpTool } from "../src/webmcp-http";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
export const installSh = join(root, "apps/web/public/install.sh");
export const webhookSecret = "whsec_e2e";
export const hostedEnv: BillingEnvironment = {
  TOOLMIRROR_HOSTED: "true",
  CREEM_API_KEY: "ck_e2e",
  CREEM_WEBHOOK_SECRET: webhookSecret,
  CREEM_PRODUCT_MONTHLY: "prod_month",
  CREEM_PRODUCT_ANNUAL: "prod_year",
};
export const selfHostedEnv: BillingEnvironment = { TOOLMIRROR_HOSTED: "false" };
export const user = { id: "user_1", email: "ada@example.com", name: "Ada" };

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function chmod755(path: string): Promise<void> {
  const chmod = Bun.spawn(["chmod", "755", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await chmod.exited) !== 0) throw new Error(`chmod failed: ${path}`);
}

export async function makeArchive(
  stagingRoot: string,
  target: ReleaseTarget,
  version: string,
): Promise<Uint8Array> {
  const staging = join(stagingRoot, target.id);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const binaryPath = join(staging, target.binary);
  await writeFile(
    binaryPath,
    `#!/bin/sh\necho "corotum ${version}"\nexit 0\n`,
    { encoding: "utf8" },
  );
  await chmod755(binaryPath);
  const archivePath = join(stagingRoot, target.archive);
  const tar = Bun.spawn(
    ["tar", "-czf", archivePath, "-C", staging, target.binary],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if ((await tar.exited) !== 0) {
    throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
  }
  return new Uint8Array(await Bun.file(archivePath).arrayBuffer());
}

export async function releaseLayout(
  version: string,
  stagingRoot: string,
): Promise<Map<string, Uint8Array>> {
  const archives = {} as Record<ReleaseTargetId, Uint8Array>;
  for (const target of RELEASE_TARGETS) {
    archives[target.id] = await makeArchive(stagingRoot, target, version);
  }
  return createReleaseLayout(
    version,
    archives,
    "0123456789abcdef0123456789abcdef01234567",
    sha256,
  );
}

export function startStaticServer(files: Map<string, Uint8Array>): {
  origin: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const key = new URL(request.url).pathname.replace(/^\//, "");
      const body = files.get(key);
      if (!body) return new Response("not found", { status: 404 });
      return new Response(Buffer.from(body));
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

export async function runInstallSh(
  home: string,
  origin: string,
  os: string,
  arch: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", installSh], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      TOOLMIRROR_RELEASE_BASE: origin,
      TOOLMIRROR_OS: os,
      TOOLMIRROR_ARCH: arch,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function runWindowsInstallerFixture(
  localAppData: string,
  files: Map<string, Uint8Array>,
  extractRoot: string,
): Promise<{ code: number; stdout: string }> {
  const dest = join(localAppData, "ToolMirror", "bin", "corotum.exe");
  const latest = JSON.parse(
    new TextDecoder().decode(files.get("releases/latest.json")),
  ) as LatestJson;
  const artifact = latest.artifacts["windows-x64"];
  const archive = files.get(artifact.object);
  if (!archive) throw new Error("missing windows-x64 archive");
  const extract = join(extractRoot, "windows-extract");
  await rm(extract, { recursive: true, force: true });
  await mkdir(extract, { recursive: true });
  const archivePath = join(extract, artifact.filename);
  await Bun.write(archivePath, archive);
  const tar = Bun.spawn(["tar", "-xzf", archivePath, "-C", extract], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await tar.exited) !== 0) throw new Error("extract failed");
  const staged = join(extract, "corotum.exe");
  await chmod755(staged);
  await mkdir(join(localAppData, "ToolMirror", "bin"), { recursive: true });
  await Bun.write(dest, Bun.file(staged));
  await chmod755(dest);
  const version = Bun.spawn(["sh", dest, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const versionOut = await new Response(version.stdout).text();
  if ((await version.exited) !== 0) throw new Error("windows --version failed");
  return {
    code: 0,
    stdout: `Official Corotum installer\nInstalled ${dest}\n${versionOut}`,
  };
}

export async function e2eDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(user.id, user.name, user.email, Date.now(), Date.now());

  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (
                (sqlite.query(query).get(...(values as never[])) as T) ?? null
              );
            },
            async run() {
              const result = sqlite.query(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T>() {
              return {
                results: sqlite.query(query).all(...(values as never[])) as T[],
              };
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db: db as unknown as TokenDatabase };
}

export async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const activatePage = `<!doctype html>
<html lang="en">
<body>
  <main>
    <h1>Approve this device</h1>
    <form id="approve">
      <label>User code <input id="code" name="userCode" /></label>
      <button type="submit">Approve device</button>
    </form>
    <p id="status" role="status"></p>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const input = document.getElementById("code");
    input.value = params.get("code") ?? "";
    document.getElementById("approve").addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = document.getElementById("status");
      try {
        const pairingId = params.get("pairing") ?? "";
        const response = await fetch("/api/v1/cli/pairings/" + pairingId + "/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userCode: input.value }),
        });
        const body = await response.json();
        status.textContent = response.ok ? "Device approved" : (body.error ?? "Unable to approve");
      } catch (error) {
        status.textContent = String(error);
      }
    });
  </script>
</body>
</html>`;

const dashboardPage = `<!doctype html>
<html lang="en">
<body>
  <main class="dashboard">
    <h1 id="title">Loading workspace…</h1>
    <section id="skills"></section>
    <section id="devices"></section>
    <section id="billing"></section>
    <p id="error" role="alert"></p>
  </main>
  <script>
    Promise.all([
      fetch("/api/v1/dashboard").then((response) => response.json()),
      fetch("/api/v1/dashboard/settings").then((response) => response.json()),
    ]).then(([dashboard, settings]) => {
      if (dashboard.error) {
        document.getElementById("error").textContent = dashboard.error;
        return;
      }
      document.getElementById("title").textContent = dashboard.workspace.name;
      document.getElementById("skills").innerHTML = "<h2>Desired skills</h2>" +
        dashboard.skills.map((skill) => skill.skill + " " + skill.resolutionStatus).join(", ");
      document.getElementById("devices").innerHTML = "<h2>Device reports</h2>" +
        dashboard.devices.map((device) => device.name + " " + device.syncStatus + " applied revision " + device.appliedRevisionSequence).join("; ");
      document.getElementById("billing").innerHTML = settings.hosted
        ? (settings.subscription
          ? "Current subscription: " + settings.subscription.status
          : "No active Cloud subscription.")
        : "This is a self-hosted Corotum Cloud instance. Cloud functionality is free and has no billing portal.";
    }).catch((error) => {
      document.getElementById("error").textContent = String(error);
    });
  </script>
</body>
</html>`;

function asResponse(value: Response | undefined): Response {
  return value ?? new Response("not found", { status: 404 });
}

export function startCloudServer(input: {
  db: TokenDatabase;
  hosted: boolean;
  env: BillingEnvironment;
}): { origin: string; stop: () => void } {
  const creem: CreemClient = {
    createCheckout: async () => ({
      checkoutUrl: "https://creem.example/checkout",
    }),
    createPortal: async () => ({ url: "https://creem.example/portal" }),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path === "/activate") {
        return new Response(activatePage, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (
        request.method === "GET" &&
        (path === "/dashboard" || path === "/dashboard/billing")
      ) {
        return new Response(dashboardPage, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "POST" && path === "/api/v1/cli/pairings") {
        return asResponse(
          await handleCreatePairing(request, input.db as never),
        );
      }
      const pairing = /^\/api\/v1\/cli\/pairings\/([^/]+)$/.exec(path);
      if (pairing?.[1] && request.method === "GET") {
        return asResponse(
          await handleGetPairing(request, input.db as never, pairing[1]),
        );
      }
      const approve = /^\/api\/v1\/cli\/pairings\/([^/]+)\/approve$/.exec(path);
      if (approve?.[1] && request.method === "POST") {
        return asResponse(
          await handleApprovePairing(
            request,
            input.db as never,
            approve[1],
            user.id,
          ),
        );
      }
      const token = /^\/api\/v1\/cli\/pairings\/([^/]+)\/token$/.exec(path);
      if (token?.[1] && request.method === "POST") {
        return asResponse(
          await handleIssueDeviceToken(request, input.db, token[1]),
        );
      }
      if (request.method === "POST" && path === "/api/v1/cli/logout") {
        return asResponse(await handleLogoutDevice(request, input.db));
      }
      const state = /^\/api\/v1\/workspaces\/([^/]+)\/state$/.exec(path);
      if (state?.[1] && request.method === "GET") {
        return asResponse(
          await handleGetWorkspaceState(
            request,
            input.db,
            state[1],
            input.hosted,
          ),
        );
      }
      if (state?.[1] && request.method === "PUT") {
        return asResponse(
          await handlePutWorkspaceState(
            request,
            input.db,
            state[1],
            input.hosted,
          ),
        );
      }
      const resolve = /^\/api\/v1\/workspaces\/([^/]+)\/state\/resolve$/.exec(
        path,
      );
      if (resolve?.[1] && request.method === "POST") {
        return asResponse(
          await handlePostPendingResolution(
            request,
            input.db,
            resolve[1],
            input.hosted,
          ),
        );
      }
      const report = /^\/api\/v1\/devices\/([^/]+)\/sync-report$/.exec(path);
      if (report?.[1] && request.method === "POST") {
        return asResponse(
          await handlePostDeviceSyncReport(
            request,
            input.db,
            report[1],
            input.hosted,
          ),
        );
      }
      const device = /^\/api\/v1\/devices\/([^/]+)$/.exec(path);
      if (device?.[1] && request.method === "GET") {
        return asResponse(
          await handleGetDeviceTargetStatus(
            request,
            input.db,
            device[1],
            user.id,
          ),
        );
      }
      if (path === "/api/v1/dashboard" && request.method === "GET") {
        return asResponse(await handleDashboardGet(input.db as never, user.id));
      }
      if (path === "/api/v1/dashboard/settings" && request.method === "GET") {
        return asResponse(
          await handleDashboardSettingsGet(input.db, user.id, input.hosted),
        );
      }
      if (path === "/api/v1/webmcp" && request.method === "POST") {
        return asResponse(
          await handleWebMcpTool(
            request,
            input.db as never,
            user.id,
            input.hosted,
          ),
        );
      }
      if (path === "/api/v1/webhooks/creem" && request.method === "POST") {
        return asResponse(
          await handleCreemWebhook(request, input.db, input.env),
        );
      }
      if (path === "/api/v1/billing/checkout" && request.method === "POST") {
        return asResponse(
          await handleBillingCheckout(
            request,
            input.db,
            input.env,
            creem,
            user,
          ),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export { CLI_VERSION_HEADER };
export { RELEASE_TARGETS };
