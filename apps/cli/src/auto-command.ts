import { watch } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Command } from "commander";
import {
  autoCloudEndpoint,
  createAutoSocket,
  probeAutoCloud,
  RevisionEventGate,
  readAutoRevision,
} from "./auto-cloud";
import { createNativeAutoService } from "./auto-native";
import {
  AUTO_FALLBACK_MS,
  type AutoStatus,
  AutoStatusStore,
  AutoSyncScheduler,
  autoRetryDelay,
} from "./auto-sync";
import { CLI_VERSION, type CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { CloudAuthError, resolveCloudOrigin } from "./cloud-auth";
import { ConfigStore, CredentialsStore } from "./config";
import { MutationLock, MutationLockedError } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { createRuntime } from "./sync-command";

export function autoPaths() {
  return resolvePlatformPaths({
    homeDir:
      process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir(),
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
}

export function registerAutoCommands(program: Command, io: CliIo): void {
  const auto = program
    .command("auto")
    .description("manage per-user automatic Cloud synchronization");
  auto
    .command("enable")
    .description("enable automatic Cloud synchronization at login")
    .action(async () => {
      const paths = autoPaths();
      const store = new ConfigStore(paths);
      const context = await requireCloud(store, new CredentialsStore(paths));
      await probeAutoCloud({ ...context, cliVersion: CLI_VERSION });
      const native = createNativeAutoService({
        home: process.env.HOME || homedir(),
      });
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const current = await requireCloud(store, new CredentialsStore(paths));
        if (
          current.origin !== context.origin ||
          current.config.origin !== context.config.origin ||
          current.workspaceId !== context.workspaceId ||
          current.config.deviceId !== context.config.deviceId ||
          current.token !== context.token
        )
          throw new Error(
            "Automatic sync configuration changed; retry enabling.",
          );
        await native.install();
        // Login-shell environment variables need not reach a native user service.
        await store.set("origin", context.origin);
        await store.set("autoSync", { enabled: true });
        await native.start();
      } finally {
        await release();
      }
      output(program, io, { enabled: true }, "Automatic Cloud sync enabled.\n");
    });
  auto
    .command("disable")
    .description("stop and remove automatic synchronization")
    .action(async () => {
      await disableAutoSync(true);
      output(
        program,
        io,
        { enabled: false },
        "Automatic Cloud sync disabled.\n",
      );
    });
  auto
    .command("status")
    .description("show native service and local automatic sync status")
    .action(async () => {
      const paths = autoPaths();
      const config = await new ConfigStore(paths).load();
      const native = await createNativeAutoService({
        home: process.env.HOME || homedir(),
      }).status();
      const saved = await new AutoStatusStore(
        join(paths.stateDir, "auto-status.json"),
      ).load();
      const operational =
        config.mode === "cloud" && saved?.workspaceId === config.workspaceId
          ? saved
          : null;
      output(
        program,
        io,
        { enabled: config.autoSync.enabled, service: native, operational },
        [
          `Automatic Cloud sync ${config.autoSync.enabled ? "enabled" : "disabled"}; service ${native.running ? "running" : "stopped"}.`,
          `Workspace: ${config.workspaceId ?? "none"}`,
          `Connection: ${native.running ? (operational?.connection ?? "unknown") : "disconnected"}`,
          `Last successful sync: ${operational?.lastSyncAt ?? "never"}`,
          `Applied revision: ${operational?.appliedRevision ?? "none"}`,
          `Last error: ${operational?.lastErrorCode ?? "none"}`,
          "",
        ].join("\n"),
      );
    });
  auto
    .command("run")
    .description(
      "run the automatic synchronization worker (service entry point)",
    )
    .action(async () => {
      await runAutoSync(program, io);
    });
}

/** Native stop drains the worker before logout acquires the shared mutation lock. */
export async function disableAutoSync(removeInstalled = false): Promise<void> {
  const paths = autoPaths();
  const store = new ConfigStore(paths);
  const enabled = (await store.load()).autoSync.enabled;
  // Task Scheduler cannot gracefully signal a task. Ask every platform's worker
  // to drain first; never kill filesystem/Git work to remove startup registration.
  const stopFile = join(paths.configDir, ".auto-stop");
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(stopFile, crypto.randomUUID(), { mode: 0o600 });
  const releaseWorker = await waitForLock(join(paths.stateDir, "auto.lock"));
  try {
    const release = await waitForLock(join(paths.stateDir, "process.lock"));
    try {
      await store.set("autoSync", { enabled: false });
    } finally {
      await release();
    }
    if (enabled || removeInstalled)
      await createNativeAutoService({
        home: process.env.HOME || homedir(),
      }).remove();
  } finally {
    await releaseWorker();
    await rm(stopFile, { force: true });
  }
}

async function waitForLock(file: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await new MutationLock(file).acquire();
    } catch (error) {
      if (!(error instanceof MutationLockedError) || Date.now() >= deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Restart an upgraded executable only after its previous worker drains. */
export async function restartAutoSyncService(): Promise<void> {
  const paths = autoPaths();
  if (!(await new ConfigStore(paths).load()).autoSync.enabled) return;
  const stopFile = join(paths.configDir, ".auto-stop");
  await writeFile(stopFile, crypto.randomUUID(), { mode: 0o600 });
  const release = await waitForLock(join(paths.stateDir, "auto.lock"));
  const native = createNativeAutoService({
    home: process.env.HOME || homedir(),
  });
  try {
    await native.stop();
  } finally {
    await rm(stopFile, { force: true });
    await release();
  }
  await native.start();
}

async function requireCloud(
  config: ConfigStore,
  credentials: CredentialsStore,
) {
  const loaded = await config.load();
  if (loaded.mode !== "cloud")
    throw new Error(
      "Automatic sync is available only in Cloud mode; Git sync remains manual.",
    );
  const token = (await credentials.load()).cloudDeviceToken;
  if (!loaded.workspaceId || !loaded.deviceId || !token)
    throw new CloudAuthError(
      "Run corotum login before enabling automatic Cloud sync.",
      "AUTH_REQUIRED",
    );
  const context = {
    config: loaded,
    token,
    workspaceId: loaded.workspaceId,
    origin: resolveCloudOrigin(undefined, loaded.origin),
  };
  autoCloudEndpoint({ ...context, cliVersion: CLI_VERSION });
  return context;
}

export async function runAutoSync(program: Command, io: CliIo): Promise<void> {
  const paths = autoPaths();
  const configStore = new ConfigStore(paths);
  if (!(await configStore.load()).autoSync.enabled) return;
  const releaseWorker = await new MutationLock(
    join(paths.stateDir, "auto.lock"),
  ).acquire();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const credentials = new CredentialsStore(paths);
    const context = await requireCloud(configStore, credentials);
    const cloudContext = { ...context, cliVersion: CLI_VERSION };
    const events = new RevisionEventGate(context.workspaceId);
    const store = new AutoStatusStore(join(paths.stateDir, "auto-status.json"));
    const saved = await store.load();
    const history = saved?.workspaceId === context.workspaceId ? saved : null;
    const status: AutoStatus = {
      schemaVersion: 1,
      pid: process.pid,
      workspaceId: context.workspaceId,
      running: true,
      connection: "connecting",
      lastCheckAt: null,
      lastSyncAt: history?.lastSyncAt ?? null,
      observedRevision: null,
      appliedRevision: history?.appliedRevision ?? null,
      outcome: "starting",
      lastErrorCode: null,
      retries: 0,
    };
    await store.save(status);
    program.setOptionValue("nonInteractive", true);
    program.setOptionValue("allowArtifacts", false);
    const silentIo: CliIo = {
      ...io,
      stdinIsTTY: false,
      writeOutput: () => {},
      writeError: () => {},
      readQuestion: undefined,
    };
    let stopped = false;
    let authBlocked = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    async function stillAuthorized() {
      let next: Awaited<ReturnType<typeof requireCloud>>;
      try {
        next = await requireCloud(configStore, credentials);
      } catch (error) {
        finish();
        throw error;
      }
      if (
        !next.config.autoSync.enabled ||
        next.workspaceId !== context.workspaceId ||
        next.origin !== context.origin ||
        next.token !== context.token
      ) {
        finish();
        throw new Error("Automatic sync configuration changed.");
      }
      return next;
    }
    const scheduler = new AutoSyncScheduler({
      status,
      persist: (value) => store.save(value),
      revision: async () => {
        await stillAuthorized();
        try {
          const metadata = await readAutoRevision(cloudContext);
          events.observe(metadata.revisionSequence);
          if (authBlocked) {
            authBlocked = false;
            connect();
          }
          return metadata.revisionId;
        } catch (error) {
          if (
            error instanceof CloudAuthError &&
            error.outcome === "AUTH_REQUIRED"
          ) {
            authBlocked = true;
            socket?.close();
          }
          throw error;
        }
      },
      sync: async () => {
        const release = await new MutationLock(
          join(paths.stateDir, "process.lock"),
        ).acquire();
        try {
          const next = await stillAuthorized();
          const runtime = await createRuntime(
            program,
            silentIo,
            true,
            next.config,
          );
          try {
            return await runtime.service.sync();
          } catch (error) {
            if (
              error instanceof CloudAuthError &&
              error.outcome === "AUTH_REQUIRED"
            ) {
              authBlocked = true;
              socket?.close();
            }
            throw error;
          }
        } finally {
          await release();
        }
      },
    });
    function connect() {
      if (stopped || authBlocked) return;
      status.connection = "connecting";
      try {
        const current = createAutoSocket(cloudContext);
        socket = current;
        handshake = setTimeout(() => current.close(), 30_000);
        current.addEventListener("open", () => {
          clearTimeout(handshake);
          if (stopped || socket !== current) {
            current.close();
            return;
          }
          reconnectAttempts = 0;
          status.connection = "connected";
          void store.save({ ...status }).catch(() => undefined);
          // Always check the head after reconnect: events are hints, not a durable queue.
          scheduler.request();
        });
        current.addEventListener("message", (event) => {
          if (events.accepts(event.data)) scheduler.request();
        });
        current.addEventListener("error", () => current.close());
        current.addEventListener("close", (event) => {
          clearTimeout(handshake);
          if (stopped || socket !== current) return;
          status.connection = "disconnected";
          void store.save({ ...status }).catch(() => undefined);
          if (event.code === 1008) scheduler.request();
          if (!stopped && !authBlocked)
            reconnect = setTimeout(
              connect,
              autoRetryDelay(reconnectAttempts++),
            );
        });
      } catch {
        status.connection = "disconnected";
        reconnect = setTimeout(connect, autoRetryDelay(reconnectAttempts++));
      }
    }
    // Rotate before the server's 60-minute session expiry. Open performs the
    // metadata fallback; only disconnected workers need an explicit request.
    const fallback = setInterval(
      () => {
        if (socket?.readyState === WebSocket.OPEN) socket.close();
        else scheduler.request();
      },
      AUTO_FALLBACK_MS - 60_000 - Math.round(Math.random() * 60_000),
    );
    let localChange: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(paths.configDir, (_event, name) => {
      if (name?.toString() === ".auto-stop") {
        finish();
        return;
      }
      if (
        name &&
        ![basename(paths.configFile), basename(paths.credentialsFile)].includes(
          name.toString(),
        )
      )
        return;
      clearTimeout(localChange);
      localChange = setTimeout(() => {
        void stillAuthorized().catch(() => finish());
      }, 200);
    });
    // A missed filesystem event is covered by the hourly authenticated fallback.
    watcher.on("error", () => watcher.close());
    let lastWakeCheck = Date.now();
    const wake = setInterval(() => {
      const now = Date.now();
      if (Math.abs(now - lastWakeCheck - 60_000) > 90_000) {
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
        else scheduler.request();
      }
      lastWakeCheck = now;
    }, 60_000);
    const shutdown = () => finish();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    cleanup = async () => {
      stopped = true;
      clearInterval(fallback);
      watcher.close();
      clearTimeout(localChange);
      clearInterval(wake);
      clearTimeout(reconnect);
      clearTimeout(handshake);
      socket?.close();
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      await scheduler.stop();
      status.running = false;
      status.connection = "disconnected";
      status.outcome = "stopped";
      await store.save(status);
    };
    connect();
    await scheduler.flush();
    await finished;
  } finally {
    try {
      await cleanup?.();
    } finally {
      await releaseWorker();
    }
  }
}

function output(
  program: Command,
  io: CliIo,
  value: Record<string, unknown>,
  human: string,
) {
  io.writeOutput(
    program.opts<{ json?: boolean }>().json
      ? `${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS", ...value }))}\n`
      : human,
  );
}
