import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION_HEADER } from "../../../packages/saas-provider/src/index";
import { ExitCode, jsonEnvelope } from "./cli-contracts";
import {
  CloudAuthError,
  CloudAuthService,
  cloudOriginFrom,
  DEVICE_CODE_HEADER,
  verificationUrlFor,
} from "./cloud-auth";
import {
  ConfigStore,
  type Credentials,
  CredentialsStore,
  defaultConfig,
  type CorotumConfig,
} from "./config";
import { SanitizedLogger } from "./logs";
import type { CorotumPaths } from "./platform";

const deviceCode = "device-code-secret-value";
const deviceToken = "plaintext-device-token-secret";
const userCode = "ABCD-EFGH";
const deviceId = "dev_1";
const workspaceId = "ws_1";
const pairingId = "pair_1";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function memoryStores(initial?: {
  config?: CorotumConfig;
  credentials?: Credentials;
}) {
  let config = initial?.config ?? defaultConfig();
  let credentials = initial?.credentials ?? { schemaVersion: 1 as const };
  return {
    config: {
      set: async (key: keyof CorotumConfig, value: unknown) => {
        config = { ...config, [key]: value } as CorotumConfig;
        return config;
      },
      snapshot: () => config,
    },
    credentials: {
      load: async () => credentials,
      save: async (value: Credentials) => {
        credentials = value;
      },
      snapshot: () => credentials,
    },
  };
}

function pairingCloud(options?: {
  pendingPolls?: number;
  logoutStatus?: number;
  tokenStatus?: number;
  pairingStatus?: number;
  expire?: boolean;
  consume?: boolean;
}): {
  fetch: typeof fetch;
  requests: Request[];
  opened: string[];
} {
  const pendingPolls = options?.pendingPolls ?? 1;
  let polls = 0;
  const requests: Request[] = [];
  const opened: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/v1/cli/pairings") {
      expect(request.headers.get(CLI_VERSION_HEADER)).toBe("0.1.0");
      return Response.json(
        {
          id: pairingId,
          deviceCode,
          userCode,
          expiresAt: Date.now() + 60_000,
        },
        { status: 201 },
      );
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/v1/cli/pairings/${pairingId}`
    ) {
      expect(request.headers.get(DEVICE_CODE_HEADER)).toBe(deviceCode);
      polls += 1;
      if (options?.pairingStatus)
        return Response.json(
          { error: "Unable to check Cloud pairing." },
          { status: options.pairingStatus },
        );
      if (options?.expire) return Response.json({ status: "EXPIRED" });
      if (options?.consume) return Response.json({ status: "CONSUMED" });
      return Response.json({
        status: polls > pendingPolls ? "APPROVED" : "PENDING",
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === `/api/v1/cli/pairings/${pairingId}/token`
    ) {
      expect(request.headers.get(DEVICE_CODE_HEADER)).toBe(deviceCode);
      if (options?.tokenStatus) {
        return Response.json(
          { error: "Unable to complete Cloud login." },
          { status: options.tokenStatus },
        );
      }
      return Response.json(
        { token: deviceToken, deviceId, workspaceId },
        { status: 201 },
      );
    }
    if (request.method === "POST" && url.pathname === "/api/v1/cli/logout") {
      expect(request.headers.get("x-toolmirror-device-token")).toBe(
        deviceToken,
      );
      return Response.json(
        { revoked: true, deviceId },
        { status: options?.logoutStatus ?? 200 },
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { fetch: fetchImpl, requests, opened };
}

function service(
  cloud: ReturnType<typeof pairingCloud>,
  stores = memoryStores(),
  extras: {
    logger?: SanitizedLogger;
    openBrowser?: boolean;
    onPairing?: (info: { userCode: string; verificationUrl: string }) => void;
  } = {},
) {
  return {
    stores,
    subject: new CloudAuthService({
      origin: "https://corotum.com",
      config: stores.config,
      credentials: stores.credentials,
      fetch: cloud.fetch,
      sleep: async () => undefined,
      openUrl: async (url) => {
        cloud.opened.push(url);
      },
      logger: extras.logger,
      openBrowser: extras.openBrowser,
      onPairing: extras.onPairing,
      device: {
        name: "test-device",
        platform: "darwin",
        architecture: "arm64",
        cliVersion: "0.1.0",
      },
    }),
  };
}

async function temporaryPaths(): Promise<CorotumPaths> {
  const root = await mkdtemp(join(tmpdir(), "corotum-cloud-auth-"));
  directories.push(root);
  return {
    configDir: join(root, "config"),
    configFile: join(root, "config", "config.json"),
    credentialsFile: join(root, "config", "credentials.json"),
    dataDir: join(root, "data"),
    gitDir: join(root, "data", "git"),
    runtimeDir: join(root, "runtime"),
    skillsDir: join(root, "data", "skills"),
    stateDir: join(root, "state"),
  };
}

describe("cloud origin", () => {
  test("rejects embedded credentials", () => {
    expect(() => cloudOriginFrom("https://user:secret@corotum.com")).toThrow(
      "Cloud origin must not include credentials.",
    );
  });
});

describe("CLI Cloud login", () => {
  test("completes browser pairing and stores the token only in credentials", async () => {
    const paths = await temporaryPaths();
    const cloud = pairingCloud();
    const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
    const pairingNotices: Array<{
      userCode: string;
      verificationUrl: string;
    }> = [];
    const subject = new CloudAuthService({
      origin: "https://corotum.com",
      config: new ConfigStore(paths),
      credentials: new CredentialsStore(paths),
      fetch: cloud.fetch,
      sleep: async () => undefined,
      openUrl: async (url) => {
        cloud.opened.push(url);
      },
      logger: {
        write: async (event, details = {}) => {
          logs.push({ event, details });
        },
      },
      onPairing: (info) => pairingNotices.push(info),
      device: {
        name: "test-device",
        platform: "darwin",
        architecture: "arm64",
        cliVersion: "0.1.0",
      },
    });

    const result = await subject.login();
    expect(result).toEqual({ deviceId, workspaceId });
    expect(cloud.opened).toEqual([
      verificationUrlFor("https://corotum.com", userCode),
    ]);
    expect(pairingNotices).toEqual([
      {
        userCode,
        verificationUrl: verificationUrlFor("https://corotum.com", userCode),
      },
    ]);

    const credentials = JSON.parse(
      await readFile(paths.credentialsFile, "utf8"),
    );
    const config = JSON.parse(await readFile(paths.configFile, "utf8"));
    expect(credentials).toEqual({
      schemaVersion: 1,
      cloudDeviceToken: deviceToken,
    });
    expect(config.cloudDeviceToken).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(deviceToken);
    expect(JSON.stringify(config)).not.toContain(deviceCode);
    expect(config).toMatchObject({ deviceId, workspaceId, mode: null });
    if (process.platform !== "win32") {
      expect((await stat(paths.credentialsFile)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.configDir)).mode & 0o777).toBe(0o700);
    }

    const serialized = JSON.stringify({ result, logs, pairingNotices });
    expect(serialized).not.toContain(deviceToken);
    expect(serialized).not.toContain(deviceCode);
    expect(JSON.stringify(logs)).not.toContain(deviceToken);
    expect(JSON.stringify(logs)).not.toContain(deviceCode);
    expect(JSON.stringify(logs)).not.toContain(userCode);
  });

  test("does not prompt and does not open a browser in non-interactive login", async () => {
    const cloud = pairingCloud();
    const { subject } = service(cloud, memoryStores(), { openBrowser: false });
    await subject.login();
    expect(cloud.opened).toEqual([]);
  });

  test("refuses a second login while credentials already exist", async () => {
    const stores = memoryStores({
      credentials: { schemaVersion: 1, cloudDeviceToken: deviceToken },
    });
    const { subject } = service(pairingCloud(), stores);
    await expect(subject.login()).rejects.toMatchObject({
      name: "CloudAuthError",
      outcome: "GENERAL_ERROR",
    });
    expect(stores.credentials.snapshot()).toEqual({
      schemaVersion: 1,
      cloudDeviceToken: deviceToken,
    });
  });

  test("expired pairing does not write credentials", async () => {
    const stores = memoryStores();
    const { subject } = service(pairingCloud({ expire: true }), stores);
    await expect(subject.login()).rejects.toBeInstanceOf(CloudAuthError);
    expect(stores.credentials.snapshot()).toEqual({ schemaVersion: 1 });
    expect(stores.config.snapshot().deviceId).toBeNull();
  });
});

describe("CLI Cloud logout", () => {
  test("revokes the server token and removes local credentials without deleting the device", async () => {
    const paths = await temporaryPaths();
    const config = new ConfigStore(paths);
    const credentials = new CredentialsStore(paths);
    await credentials.save({ schemaVersion: 1, cloudDeviceToken: deviceToken });
    await config.set("deviceId", deviceId);
    await config.set("workspaceId", workspaceId);

    const cloud = pairingCloud();
    const subject = new CloudAuthService({
      origin: "https://corotum.com",
      config,
      credentials,
      fetch: cloud.fetch,
    });

    expect(await subject.logout()).toEqual({ revoked: true, deviceId });
    expect(
      cloud.requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual(["POST /api/v1/cli/logout"]);
    expect(await credentials.load()).toEqual({ schemaVersion: 1 });
    expect(await config.load()).toMatchObject({
      deviceId: null,
      workspaceId: null,
    });
    expect(await readFile(paths.credentialsFile, "utf8")).not.toContain(
      deviceToken,
    );
  });

  test("clears local credentials when the server token is already invalid", async () => {
    const stores = memoryStores({
      credentials: { schemaVersion: 1, cloudDeviceToken: deviceToken },
      config: { ...defaultConfig(), deviceId, workspaceId },
    });
    const { subject } = service(pairingCloud({ logoutStatus: 401 }), stores);
    expect(await subject.logout()).toEqual({ revoked: true, deviceId: null });
    expect(stores.credentials.snapshot()).toEqual({ schemaVersion: 1 });
    expect(stores.config.snapshot()).toMatchObject({
      deviceId: null,
      workspaceId: null,
    });
  });

  test("clears local credentials when logout cannot revoke on Cloud", async () => {
    const stores = memoryStores({
      credentials: { schemaVersion: 1, cloudDeviceToken: deviceToken },
      config: { ...defaultConfig(), deviceId, workspaceId },
    });
    const { subject } = service(pairingCloud({ logoutStatus: 503 }), stores);
    await expect(subject.logout()).rejects.toMatchObject({
      outcome: "NETWORK_ERROR",
    });
    expect(stores.credentials.snapshot()).toEqual({ schemaVersion: 1 });
    expect(stores.config.snapshot()).toMatchObject({
      deviceId: null,
      workspaceId: null,
    });
  });

  test("treats a logged-out CLI as already clean", async () => {
    const { subject } = service(pairingCloud());
    expect(await subject.logout()).toEqual({ revoked: false, deviceId: null });
  });
});

describe("CLI Cloud auth output contracts", () => {
  test("JSON envelopes omit pairing and device secrets", () => {
    const output = jsonEnvelope({
      outcome: "SUCCESS",
      deviceId,
      workspaceId,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(deviceToken);
    expect(serialized).not.toContain(deviceCode);
    expect(serialized).not.toContain(userCode);
    expect(output.schemaVersion).toBe(1);
  });

  test("auth failures map onto documented exit codes", () => {
    expect(
      new CloudAuthError("Cloud request failed.", "NETWORK_ERROR").outcome,
    ).toBe("NETWORK_ERROR");
    expect(ExitCode.NETWORK_ERROR).toBe(6);
    expect(ExitCode.AUTH_REQUIRED).toBe(4);
  });

  test("sanitized logs redact pairing and device secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-cloud-logs-"));
    directories.push(root);
    const logger = new SanitizedLogger(join(root, "logs"));
    await logger.write("cloud.login.started", {
      deviceCode,
      userCode,
      token: deviceToken,
      pairingId,
    });
    const output = await readFile(join(root, "logs", "corotum.log"), "utf8");
    expect(output).not.toContain(deviceCode);
    expect(output).not.toContain(userCode);
    expect(output).not.toContain(deviceToken);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain(pairingId);
  });
});
