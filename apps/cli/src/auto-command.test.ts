import { expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoPaths, disableAutoSync, runAutoSync } from "./auto-command";
import { AutoStatusStore } from "./auto-sync";
import { createCli, runCli } from "./cli";
import { ConfigStore, CredentialsStore, defaultConfig } from "./config";

async function fixture(work: () => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "corotum-auto-command-"));
  const keys = [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of keys.slice(2)) process.env[key] = join(home, key);
  try {
    await work();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(home, { recursive: true, force: true });
  }
}
const io = {
  stdinIsTTY: false,
  writeOutput: (_: string) => {},
  writeError: (_: string) => {},
};

for (const changed of ["origin", "workspaceId", "deviceId", "token"]) {
  test(`auto enable refuses ${changed} changed during its probe`, async () =>
    fixture(async () => {
      const paths = autoPaths();
      const config = new ConfigStore(paths);
      const credentials = new CredentialsStore(paths);
      const previousOrigin = process.env.COROTUM_CLOUD_ORIGIN;
      const server = Bun.serve({
        port: 0,
        async fetch(request, server) {
          if (new URL(request.url).pathname.endsWith("/events")) {
            if (server.upgrade(request)) return;
            return new Response(null, { status: 400 });
          }
          if (changed === "token")
            await credentials.save({
              schemaVersion: 1,
              cloudDeviceToken: "new-token",
            });
          else
            await config.set(
              changed,
              changed === "origin" ? "https://changed.example" : "changed",
            );
          return Response.json({ revisionId: null, revisionSequence: 0 });
        },
        websocket: { message() {} },
      });
      try {
        const origin = `http://localhost:${server.port}`;
        process.env.COROTUM_CLOUD_ORIGIN = origin;
        await config.set("mode", "cloud");
        await config.set("origin", origin);
        await config.set("workspaceId", "w");
        await config.set("deviceId", "d");
        await credentials.save({ schemaVersion: 1, cloudDeviceToken: "token" });
        let error = "";
        expect(
          await runCli(["auto", "enable"], {
            ...io,
            writeError: (text) => {
              error += text;
            },
          }),
        ).not.toBe(0);
        expect(error).toContain("configuration changed");
        expect((await config.load()).autoSync.enabled).toBe(false);
        expect((await config.load()).origin).toBe(
          changed === "origin" ? "https://changed.example" : origin,
        );
        if (changed === "token")
          expect((await credentials.load()).cloudDeviceToken).toBe("new-token");
        else if (changed !== "origin")
          expect((await config.load())[changed]).toBe("changed");
      } finally {
        if (previousOrigin === undefined)
          delete process.env.COROTUM_CLOUD_ORIGIN;
        else process.env.COROTUM_CLOUD_ORIGIN = previousOrigin;
        server.stop(true);
      }
    }));
}

test("old schema-1 configs default disabled; Git auto enable refuses without changing config", async () =>
  fixture(async () => {
    const paths = autoPaths();
    await mkdir(paths.configDir, { recursive: true });
    const { autoSync: _, ...old } = defaultConfig();
    await writeFile(
      paths.configFile,
      JSON.stringify({
        ...old,
        mode: "git",
        gitRepository: "https://example.com/repo.git",
      }),
    );
    expect((await new ConfigStore(paths).load()).autoSync).toEqual({
      enabled: false,
    });
    const before = await readFile(paths.configFile, "utf8");
    expect(await runCli(["--non-interactive", "auto", "enable"], io)).not.toBe(
      0,
    );
    expect(await readFile(paths.configFile, "utf8")).toBe(before);
    expect(await runCli(["--non-interactive", "auto", "run"], io)).toBe(0);
  }));

test("Cloud worker authenticates WS and metadata, startup sync holds mutation lock, idle hints do not pull", async () =>
  fixture(async () => {
    const paths = autoPaths();
    let pulls = 0;
    let metadata = 0;
    let upgrades = 0;
    let mutationLocked = false;
    let preservedHistory = false;
    let invalidHeaders = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request, server) {
        invalidHeaders ||=
          request.headers.get("x-toolmirror-device-token") !==
            "test-private-token" ||
          !request.headers.get("x-toolmirror-cli-version") ||
          request.headers.has("authorization");
        const url = new URL(request.url);
        if (url.pathname.endsWith("/events")) {
          upgrades++;
          if (server.upgrade(request)) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        if (url.pathname.endsWith("/revision")) {
          metadata++;
          return Response.json({ revisionId: "r1", revisionSequence: 1 });
        }
        if (url.pathname.endsWith("/state")) {
          pulls++;
          await access(join(paths.stateDir, "process.lock"));
          mutationLocked = true;
          const startup = await new AutoStatusStore(
            join(paths.stateDir, "auto-status.json"),
          ).load();
          preservedHistory =
            startup?.lastSyncAt === "2026-01-01T00:00:00.000Z" &&
            startup.appliedRevision === "r0";
          return Response.json({
            revisionId: "r1",
            revisionSequence: 1,
            state: {
              manifest: { version: 2, skills: [] },
              lockfile: { version: 2, skills: [] },
            },
            dispositionLedger: { version: 2, activeDispositions: {} },
          });
        }
        return Response.json({
          deviceId: "d",
          workspaceId: "w",
          appliedRevisionId: "r1",
          appliedRevisionSequence: 1,
          syncStatus: "SYNCED",
          lastErrorCode: null,
          lastErrorMessage: null,
          lastSyncAt: Date.now(),
        });
      },
      websocket: {
        open(socket) {
          for (let i = 0; i < 30; i++)
            socket.send(
              JSON.stringify({
                type: "revision.updated",
                workspaceId: "w",
                revisionId: "r1",
                revisionSequence: 1,
              }),
            );
        },
        message() {},
      },
    });
    const config = new ConfigStore(paths);
    await config.set("mode", "cloud");
    await config.set("workspaceId", "w");
    await config.set("deviceId", "d");
    await config.set("origin", `http://localhost:${server.port}`);
    await config.set("autoSync", { enabled: true });
    await new CredentialsStore(paths).save({
      schemaVersion: 1,
      cloudDeviceToken: "test-private-token",
    });
    await new AutoStatusStore(join(paths.stateDir, "auto-status.json")).save({
      schemaVersion: 1,
      pid: 99,
      workspaceId: "w",
      running: false,
      connection: "disconnected",
      lastCheckAt: null,
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      observedRevision: "r0",
      appliedRevision: "r0",
      outcome: "stopped",
      lastErrorCode: null,
      retries: 0,
    });
    const worker = runAutoSync(createCli(io), io);
    try {
      const until = Date.now() + 4500;
      while (metadata === 0 && Date.now() < until) await Bun.sleep(10);
      expect(upgrades).toBe(1);
      expect(metadata).toBe(1);
      expect(pulls).toBe(1);
      expect(mutationLocked).toBe(true);
      expect(preservedHistory).toBe(true);
      expect(invalidHeaders).toBe(false);
      const saved = await new AutoStatusStore(
        join(paths.stateDir, "auto-status.json"),
      ).load();
      expect(saved?.appliedRevision).toBe("r1");
      expect(JSON.stringify(saved)).not.toContain("test-private-token");
    } finally {
      await disableAutoSync();
      await worker;
      server.stop(true);
    }
    expect(
      (
        await new AutoStatusStore(
          join(paths.stateDir, "auto-status.json"),
        ).load()
      )?.running,
    ).toBe(false);
    expect((await config.load()).autoSync.enabled).toBe(false);
  }));
