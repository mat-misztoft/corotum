import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliUpdate } from "../../../apps/cli/src/cli-update";
import { CloudAuthService } from "../../../apps/cli/src/cloud-auth";
import { LocalOperationalStateStore } from "../../../apps/cli/src/local-state";
import { MigrationService } from "../../../apps/cli/src/migrate";
import { MutationLock } from "../../../apps/cli/src/mutation-lock";
import { LocalReconcileExecutor } from "../../../apps/cli/src/reconcile-executor";
import { RestoreService } from "../../../apps/cli/src/restore";
import { SyncService } from "../../../apps/cli/src/sync";
import {
  type DesiredState,
  type LockedSkill,
  planReconcile,
  revisionId,
  skillId,
} from "../../../packages/core/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import {
  postDeviceSyncReport,
  SaaSProvider,
} from "../../../packages/saas-provider/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import {
  type GitCommandRunner,
  GitSkillMaterializer,
} from "../../../packages/skills-adapter/src/git-source";
import {
  e2eDb,
  hostedEnv,
  releaseLayout,
  runInstallSh,
  runWindowsInstallerFixture,
  selfHostedEnv,
  sign,
  startCloudServer,
  startStaticServer,
  tempDir,
  webhookSecret,
} from "./harness";

const evidencePath = fileURLToPath(
  new URL("./fresh-install-evidence.md", import.meta.url),
);
const roots: string[] = [];
const timeout = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

async function gitFixture() {
  const root = await tempDir("corotum-e2e-git-");
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "state.git");
  const stateWorktree = join(root, "state-worktree");
  await git(["init", "--initial-branch=main", source]);
  await git(["-C", source, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", source, "config", "user.name", "Corotum tests"]);
  for (const [name, contents] of [
    ["adopted", "adopted exact bytes\n"],
    ["added", "added exact bytes\n"],
  ] as const) {
    await mkdir(join(source, "skills", name), { recursive: true });
    await writeFile(join(source, "skills", name, "SKILL.md"), contents);
  }
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "skills"]);
  await git(["init", "--initial-branch=main", stateWorktree]);
  await git([
    "-C",
    stateWorktree,
    "config",
    "user.email",
    "tests@corotum.invalid",
  ]);
  await git(["-C", stateWorktree, "config", "user.name", "Corotum tests"]);
  await git(["-C", stateWorktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", remote]);
  await git(["-C", stateWorktree, "remote", "add", "origin", remote]);
  await git(["-C", stateWorktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, source, remote, stateWorktree };
}

function desired(locks: readonly LockedSkill[]): DesiredState {
  return {
    manifest: {
      version: 1,
      skills: locks.map((lock) => ({
        id: lock.id,
        source: lock.source,
        skill: lock.skill,
        ref: lock.ref,
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      })),
    },
    lockfile: { version: 1, skills: locks },
  };
}

async function lockFor(
  source: string,
  id: ReturnType<typeof skillId>,
  name: string,
) {
  const resolved = await new GitSkillMaterializer().resolve({
    id,
    source,
    skill: name,
    ref: "main",
    path: `skills/${name}`,
  });
  return { id, source, skill: name, ref: "main", ...resolved };
}

function emptyState() {
  return { schemaVersion: 1 as const, lastAppliedRevision: null, skills: {} };
}

function fetchWithIp(ip: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", ip);
    return fetch(input, { ...init, headers });
  };
}

function memoryAuth() {
  let config: Record<string, unknown> = {};
  let credentials: { schemaVersion: 1; cloudDeviceToken?: string } = {
    schemaVersion: 1,
  };
  return {
    config: {
      set: async (key: string, value: unknown) => {
        config = { ...config, [key]: value };
        return config;
      },
    },
    credentials: {
      load: async () => credentials,
      save: async (value: typeof credentials) => {
        credentials = value;
      },
      snapshot: () => credentials,
    },
  };
}

async function pairDirect(origin: string, name: string, ip: string) {
  const created = await fetch(`${origin}/api/v1/cli/pairings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-toolmirror-cli-version": "0.1.0",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify({
      name,
      platform: "darwin",
      architecture: "arm64",
      cliVersion: "0.1.0",
    }),
  });
  expect(created.status).toBe(201);
  const pairing = (await created.json()) as {
    id: string;
    userCode: string;
    deviceCode: string;
  };
  const approved = await fetch(
    `${origin}/api/v1/cli/pairings/${pairing.id}/approve`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "cf-connecting-ip": `${ip}-browser`,
      },
      body: JSON.stringify({ userCode: pairing.userCode }),
    },
  );
  expect(approved.status).toBe(200);
  const issued = await fetch(
    `${origin}/api/v1/cli/pairings/${pairing.id}/token`,
    {
      method: "POST",
      headers: {
        "x-toolmirror-cli-version": "0.1.0",
        "x-toolmirror-device-code": pairing.deviceCode,
        "cf-connecting-ip": ip,
      },
    },
  );
  expect(issued.status).toBe(201);
  return (await issued.json()) as {
    token: string;
    deviceId: string;
    workspaceId: string;
  };
}

async function loginWithCli(
  origin: string,
  sqlite: Database,
  name: string,
  ip: string,
) {
  const stores = memoryAuth();
  const pending = new CloudAuthService({
    origin,
    config: stores.config as never,
    credentials: stores.credentials,
    pollIntervalMs: 20,
    openBrowser: false,
    device: {
      name,
      platform: "darwin",
      architecture: "arm64",
      cliVersion: "0.1.0",
    },
    fetch: fetchWithIp(ip),
  }).login();

  let pairing: { id: string; user_code: string } | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    pairing = sqlite
      .query(
        "SELECT id, user_code FROM cli_pairings WHERE device_name = ? AND status = 'PENDING'",
      )
      .get(name) as { id: string; user_code: string } | null;
    if (pairing) break;
    await Bun.sleep(15);
  }
  expect(pairing).toBeTruthy();
  const approved = await fetch(
    `${origin}/api/v1/cli/pairings/${pairing?.id}/approve`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "cf-connecting-ip": `${ip}-browser`,
      },
      body: JSON.stringify({ userCode: pairing?.user_code }),
    },
  );
  expect(approved.status).toBe(200);
  const result = await pending;
  const token = stores.credentials.snapshot().cloudDeviceToken;
  expect(token).toBeString();
  return {
    ...result,
    token: token as string,
    workspaceId: result.workspaceId as string,
  };
}

test(
  "fresh installers produce a runnable CLI before Git and Cloud flows",
  async () => {
    const work = await tempDir("corotum-e2e-install-");
    roots.push(work);
    const files = await releaseLayout("0.1.0", join(work, "staging"));
    const server = startStaticServer(files);
    try {
      const unixHome = join(work, "unix-home");
      await mkdir(unixHome, { recursive: true });
      const unix = await runInstallSh(
        unixHome,
        server.origin,
        "darwin",
        "arm64",
      );
      expect(unix.code).toBe(0);
      expect(unix.stdout).toContain("Official Corotum installer");
      const dest = join(unixHome, ".local/bin/corotum");
      const version = Bun.spawn([dest, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await version.exited).toBe(0);
      expect(await new Response(version.stdout).text()).toBe("corotum 0.1.0\n");

      const windows = await runWindowsInstallerFixture(
        join(work, "windows-home"),
        files,
        join(work, "windows-extract"),
      );
      expect(windows.code).toBe(0);
      expect(windows.stdout).toContain("Official Corotum installer");
      expect(windows.stdout).toContain("corotum 0.1.0");
    } finally {
      server.stop();
    }
  },
  timeout,
);

test(
  "Git Sync completes without a Corotum Cloud subscription",
  async () => {
    const { root, source, remote, stateWorktree } = await gitFixture();
    const adopted = await lockFor(source, skillId("sk_adopted"), "adopted");
    const added = await lockFor(source, skillId("sk_added"), "added");
    const machineA = new GitStateProvider(join(root, "home-a", "git"), remote);
    const base = revisionId(
      (await git(["-C", stateWorktree, "rev-parse", "HEAD"])).trim(),
    );
    const adoption = await machineA.push(
      { state: desired([adopted]), baseRevision: base },
      { type: "ADOPT", skillId: adopted.id, metadata: {} },
    );
    expect(adoption).toMatchObject({ kind: "success" });
    if (adoption.kind !== "success") throw new Error("adoption failed");
    const addition = await machineA.push(
      {
        state: desired([adopted, added]),
        baseRevision: adoption.value.revisionId,
      },
      { type: "ADD", skillId: added.id, metadata: {} },
    );
    expect(addition).toMatchObject({ kind: "success" });

    const homeB = join(root, "home-b");
    await mkdir(join(homeB, ".codex", "skills", "unmanaged"), {
      recursive: true,
    });
    await writeFile(
      join(homeB, ".codex", "skills", "unmanaged", "SKILL.md"),
      "keep me\n",
    );
    const synced = await new SyncService(
      new GitStateProvider(join(homeB, "git"), remote),
      new LocalReconcileExecutor(
        new LocalOperationalStateStore(join(homeB, "state", "state.json")),
        new CanonicalSkillStore(join(homeB, "skills")),
      ),
    ).sync({
      execution: { state: emptyState(), enabledAgentIds: [], homeDir: homeB },
    });
    expect(synced).toMatchObject({ kind: "synced" });
    expect(
      await readFile(
        join(homeB, ".codex", "skills", "unmanaged", "SKILL.md"),
        "utf8",
      ),
    ).toBe("keep me\n");
    for (const lock of [adopted, added]) {
      expect(await hashSkillDirectory(join(homeB, "skills", lock.skill))).toBe(
        lock.contentHash,
      );
    }

    const runner: GitCommandRunner = async ({ args }) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stderr: "",
            stdout: new TextEncoder().encode("git version"),
          }
        : {
            exitCode: 128,
            stderr: "Permission denied (publickey).",
            stdout: new Uint8Array(),
          };
    const auth = await new GitStateProvider(
      join(root, "private"),
      "git@private.example:owner/skills.git",
      runner,
    ).pull();
    expect(auth).toMatchObject({
      kind: "failure",
      error: { code: "AUTH_REQUIRED" },
    });

    const store = new CanonicalSkillStore(join(root, "drift", "skills"));
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(root, "drift", "state.json")),
      store,
    );
    await executor.execute({
      plan: planReconcile(desired([adopted]), { skills: {} }),
      desired: desired([adopted]),
      revision: revisionId("one"),
      state: emptyState(),
      enabledAgentIds: [],
      homeDir: join(root, "drift"),
    });
    await writeFile(
      join(store.pathFor(adopted.skill), "SKILL.md"),
      "drifted bytes\n",
    );
    const restored = await new RestoreService(
      {
        pull: async () => ({
          kind: "success",
          value: { revisionId: revisionId("one"), state: desired([adopted]) },
        }),
      },
      executor,
    ).restore({
      all: true,
      execution: {
        state: {
          schemaVersion: 1,
          lastAppliedRevision: revisionId("one"),
          skills: {
            [adopted.id]: {
              name: adopted.skill,
              canonicalPath: store.pathFor(adopted.skill),
              contentHash: adopted.contentHash,
              targets: {},
            },
          },
        },
        enabledAgentIds: [],
        homeDir: join(root, "drift"),
      },
    });
    expect(restored).toMatchObject({ kind: "restored" });
    expect(await hashSkillDirectory(store.pathFor(adopted.skill))).toBe(
      adopted.contentHash,
    );
  },
  timeout,
);

test(
  "hosted Cloud is available during the launch period; self-hosted Cloud stays free",
  async () => {
    const { root, source, remote, stateWorktree } = await gitFixture();
    const lock = await lockFor(source, skillId("sk_review"), "adopted");
    const extra = await lockFor(source, skillId("sk_added"), "added");
    const hosted = await e2eDb();
    const hostedServer = startCloudServer({
      db: hosted.db,
      hosted: true,
      env: hostedEnv,
    });
    const self = await e2eDb();
    const selfServer = startCloudServer({
      db: self.db,
      hosted: false,
      env: selfHostedEnv,
    });
    try {
      const studio = await loginWithCli(
        hostedServer.origin,
        hosted.sqlite,
        "studio",
        "10.0.0.1",
      );
      const unpaid = await new SaaSProvider({
        origin: hostedServer.origin,
        workspaceId: studio.workspaceId,
        deviceToken: studio.token,
        fetch: fetchWithIp("10.0.0.1"),
      }).pull();
      expect(unpaid.kind).toBe("success");

      const payload = JSON.stringify({
        id: "evt_e2e_paid",
        eventType: "subscription.paid",
        object: {
          id: "sub_e2e",
          status: "active",
          customer: { id: "cus_ada" },
          metadata: { userId: "user_1", billingInterval: "month" },
        },
      });
      const webhook = await fetch(
        `${hostedServer.origin}/api/v1/webhooks/creem`,
        {
          method: "POST",
          headers: { "creem-signature": await sign(payload, webhookSecret) },
          body: payload,
        },
      );
      expect(webhook.status).toBe(200);

      const providerA = new SaaSProvider({
        origin: hostedServer.origin,
        workspaceId: studio.workspaceId,
        deviceToken: studio.token,
        fetch: fetchWithIp("10.0.0.1"),
      });
      const pulled = await providerA.pull();
      expect(pulled.kind).toBe("success");
      if (pulled.kind !== "success") throw new Error("hosted pull failed");
      const added = await providerA.push(
        { state: desired([lock]), baseRevision: pulled.value.revisionId },
        { type: "ADD", skillId: lock.id, metadata: {} },
      );
      expect(added.kind).toBe("success");
      if (added.kind !== "success") throw new Error("hosted add failed");

      const premature = await postDeviceSyncReport({
        origin: hostedServer.origin,
        deviceId: studio.deviceId,
        deviceToken: studio.token,
        fetch: fetchWithIp("10.0.0.1"),
        report: { appliedRevisionId: null, syncStatus: "BEHIND" },
      });
      expect(premature).toMatchObject({
        kind: "success",
        value: { syncStatus: "BEHIND", appliedRevisionSequence: 0 },
      });

      const laptop = await pairDirect(
        hostedServer.origin,
        "laptop",
        "10.0.0.2",
      );
      const dashboardBefore = await fetch(
        `${hostedServer.origin}/api/v1/dashboard`,
      );
      const beforeBody = (await dashboardBefore.json()) as {
        devices: Array<{ name: string; syncStatus: string }>;
      };
      expect(
        beforeBody.devices.find((device) => device.name === "laptop")
          ?.syncStatus,
      ).toBe("NEVER_SYNCED");

      expect(
        await postDeviceSyncReport({
          origin: hostedServer.origin,
          deviceId: studio.deviceId,
          deviceToken: studio.token,
          fetch: fetchWithIp("10.0.0.1"),
          report: {
            appliedRevisionId: added.value.revisionId,
            syncStatus: "SYNCED",
            targets: [
              {
                skillId: lock.id,
                agentId: "codex",
                status: "SYNCED",
                contentHash: lock.contentHash,
              },
            ],
            updates: [{ skillId: lock.id, status: "UP_TO_DATE" }],
          },
        }),
      ).toMatchObject({ kind: "success", value: { syncStatus: "SYNCED" } });

      const providerB = new SaaSProvider({
        origin: hostedServer.origin,
        workspaceId: laptop.workspaceId,
        deviceToken: laptop.token,
        fetch: fetchWithIp("10.0.0.2"),
      });
      const laptopState = await providerB.pull();
      expect(laptopState).toMatchObject({
        kind: "success",
        value: { revisionId: added.value.revisionId },
      });
      const laptopHome = join(root, "laptop");
      expect(
        await new SyncService(
          providerB,
          new LocalReconcileExecutor(
            new LocalOperationalStateStore(join(laptopHome, "state.json")),
            new CanonicalSkillStore(join(laptopHome, "skills")),
          ),
        ).sync({
          execution: {
            state: emptyState(),
            enabledAgentIds: [],
            homeDir: laptopHome,
          },
        }),
      ).toMatchObject({ kind: "synced" });
      await postDeviceSyncReport({
        origin: hostedServer.origin,
        deviceId: laptop.deviceId,
        deviceToken: laptop.token,
        fetch: fetchWithIp("10.0.0.2"),
        report: {
          appliedRevisionId: added.value.revisionId,
          syncStatus: "SYNCED",
        },
      });

      const pending = await fetch(`${hostedServer.origin}/api/v1/webmcp`, {
        method: "POST",
        headers: {
          origin: hostedServer.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "set_skill_ref",
          baseRevisionId: added.value.revisionId,
          idempotencyKey: "webmcp-ref",
          arguments: { skillId: lock.id, ref: "release" },
        }),
      });
      expect(pending.status).toBe(200);
      const pendingBody = (await pending.json()) as {
        revisionId: string;
        pendingResolution: string[];
      };
      expect(pendingBody.pendingResolution).toEqual([lock.id]);

      expect(
        await postDeviceSyncReport({
          origin: hostedServer.origin,
          deviceId: studio.deviceId,
          deviceToken: studio.token,
          fetch: fetchWithIp("10.0.0.1"),
          report: {
            appliedRevisionId: added.value.revisionId,
            syncStatus: "SYNCED",
          },
        }),
      ).toMatchObject({ kind: "success", value: { syncStatus: "BEHIND" } });

      const resolved = await providerA.resolvePending({
        skillId: lock.id,
        baseRevision: pendingBody.revisionId,
        repository: lock.source,
        revision: lock.revision,
        path: lock.path,
        contentHash: lock.contentHash,
      });
      expect(resolved.kind).toBe("success");
      if (resolved.kind !== "success") throw new Error("resolution failed");
      expect(
        await postDeviceSyncReport({
          origin: hostedServer.origin,
          deviceId: studio.deviceId,
          deviceToken: studio.token,
          fetch: fetchWithIp("10.0.0.1"),
          report: {
            appliedRevisionId: resolved.value.revisionId,
            syncStatus: "SYNCED",
          },
        }),
      ).toMatchObject({ kind: "success", value: { syncStatus: "SYNCED" } });

      const listed = await fetch(`${hostedServer.origin}/api/v1/webmcp`, {
        method: "POST",
        headers: {
          origin: hostedServer.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "get_sync_status" }),
      });
      expect(listed.status).toBe(200);

      const gitRemote = new GitStateProvider(join(root, "migrate-git"), remote);
      const gitBase = revisionId(
        (await git(["-C", stateWorktree, "rev-parse", "HEAD"])).trim(),
      );
      const gitPush = await gitRemote.push(
        { state: desired([extra]), baseRevision: gitBase },
        { type: "ADD", skillId: extra.id, metadata: {} },
      );
      expect(gitPush.kind).toBe("success");
      const migrated = await new MigrationService(gitRemote, providerA).migrate(
        "merge",
      );
      expect(migrated.kind).toBe("migrated");

      const selfStudio = await pairDirect(
        selfServer.origin,
        "studio",
        "10.1.0.1",
      );
      const selfProvider = new SaaSProvider({
        origin: selfServer.origin,
        workspaceId: selfStudio.workspaceId,
        deviceToken: selfStudio.token,
        fetch: fetchWithIp("10.1.0.1"),
      });
      const selfPull = await selfProvider.pull();
      expect(selfPull.kind).toBe("success");
      if (selfPull.kind !== "success")
        throw new Error("self-hosted pull failed");
      expect(
        await selfProvider.push(
          { state: desired([lock]), baseRevision: selfPull.value.revisionId },
          { type: "ADD", skillId: lock.id, metadata: {} },
        ),
      ).toMatchObject({ kind: "success" });
      const checkout = await fetch(
        `${selfServer.origin}/api/v1/billing/checkout`,
        {
          method: "POST",
          headers: {
            origin: selfServer.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ interval: "month" }),
        },
      );
      expect(checkout.status).toBe(404);
    } finally {
      hostedServer.stop();
      selfServer.stop();
    }
  },
  timeout,
);

test(
  "CLI update replaces the official binary after a fresh install",
  async () => {
    const work = await tempDir("corotum-e2e-update-");
    roots.push(work);
    const currentFiles = await releaseLayout("0.1.0", join(work, "current"));
    const latestFiles = await releaseLayout("0.1.1", join(work, "latest"));
    const currentServer = startStaticServer(currentFiles);
    const latestServer = startStaticServer(latestFiles);
    try {
      const home = join(work, "home");
      await mkdir(home, { recursive: true });
      const installed = await runInstallSh(
        home,
        currentServer.origin,
        "darwin",
        "arm64",
      );
      expect(installed.code).toBe(0);
      const dest = join(home, ".local/bin/corotum");
      const lock = new MutationLock(join(home, "process.lock"));
      const updated = await cliUpdate(
        {
          currentVersion: "0.1.0",
          platform: "darwin",
          arch: "arm64",
          executablePath: dest,
          pendingDir: join(home, "pending"),
          releaseBase: latestServer.origin,
          fetchBytes: async (url) =>
            new Uint8Array(await (await fetch(url)).arrayBuffer()),
          acquireLock: () => lock.acquire(),
        },
        { check: false },
      );
      expect(updated.status).toBe("UPDATED");
      const version = Bun.spawn([dest, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await version.exited).toBe(0);
      expect(await new Response(version.stdout).text()).toBe("corotum 0.1.1\n");
    } finally {
      currentServer.stop();
      latestServer.stop();
    }
  },
  timeout,
);

test("fresh-install evidence records every required path as PASS", async () => {
  const evidence = await Bun.file(evidencePath).text();
  for (const path of [
    "Official installer simulation",
    "Git Sync without Cloud subscription",
    "Hosted Cloud launch access",
    "Hosted Cloud after launch",
    "Self-hosted Cloud without Creem",
    "Adoption and add",
    "Two-device sync",
    "Private AUTH_REQUIRED",
    "PENDING_RESOLUTION",
    "Device reporting",
    "Migration",
    "WebMCP",
    "Drift/restore",
    "CLI update",
    "Unmanaged content intact",
    "Status never SYNCED before apply",
    "Playwright critical browser flows",
  ]) {
    expect(
      evidence
        .split("\n")
        .some(
          (line) => line.startsWith(`| ${path} |`) && line.endsWith(" PASS |"),
        ),
    ).toBe(true);
  }
  expect(evidence.match(/\| FAIL \|/g) ?? []).toEqual([]);
});
