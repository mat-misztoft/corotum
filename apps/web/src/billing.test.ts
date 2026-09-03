import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BillingDatabase,
  type BillingEnvironment,
  type CreemCheckoutInput,
  type CreemClient,
  HOSTED_ANNUAL_PRICE_CENTS,
  HOSTED_MONTHLY_PRICE_CENTS,
  hasHostedCloudAccess,
  isLaunchFreePeriod,
  processCreemWebhook,
  verifyCreemSignature,
} from "./billing";
import {
  handleBillingCheckout,
  handleBillingPortal,
  handleCreemWebhook,
} from "./billing-http";
import { CLI_VERSION_HEADER } from "./cli-compat";
import { approvePairing, createPairing } from "./pairings";
import { handleCreatePairing } from "./pairings-http";
import { handleGetWorkspaceState, handlePutWorkspaceState } from "./state-http";
import { issueDeviceToken, type TokenDatabase } from "./tokens";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const webhookSecret = "whsec_test";
const hostedEnv: BillingEnvironment = {
  COROTUM_HOSTED: "true",
  CREEM_API_KEY: "ck_test",
  CREEM_WEBHOOK_SECRET: webhookSecret,
  CREEM_PRODUCT_MONTHLY: "prod_month",
  CREEM_PRODUCT_ANNUAL: "prod_year",
};
const selfHostedEnv: BillingEnvironment = { COROTUM_HOSTED: "false" };
const device = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};
const launchEnd = Date.parse("2026-10-01T00:00:00.000Z");

async function afterLaunch<T>(run: () => Promise<T>) {
  const now = Date.now;
  Date.now = () => launchEnd;
  try {
    return await run();
  } finally {
    Date.now = now;
  }
}

async function billingDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.query(query).get(...values) as T) ?? null;
            },
            async run() {
              const result = sqlite.query(query).run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T>() {
              return { results: sqlite.query(query).all(...values) as T[] };
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
  } as BillingDatabase & TokenDatabase;

  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run("user_1", "Ada", "ada@example.com", Date.now(), Date.now());
  return { sqlite, db };
}

async function sign(payload: string, secret: string) {
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

function mockCreem() {
  const checkouts: CreemCheckoutInput[] = [];
  const portals: string[] = [];
  const creem: CreemClient = {
    async createCheckout(input) {
      checkouts.push(input);
      return { checkoutUrl: "https://creem.io/checkout/cs_test" };
    },
    async createPortal(customerId) {
      portals.push(customerId);
      return { url: `https://creem.io/portal/${customerId}` };
    },
  };
  return { creem, checkouts, portals };
}

function jsonRequest(
  path: string,
  body: unknown,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(`https://corotum.com${path}`, {
    method: "POST",
    ...init,
    headers: {
      origin: "https://corotum.com",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

test("monthly and annual checkout charge $5.99 and $59.90 for the signed-in customer", async () => {
  const { db } = await billingDb();
  const { creem, checkouts } = mockCreem();
  const user = { id: "user_1", email: "ada@example.com", name: "Ada" };

  const monthly = await handleBillingCheckout(
    jsonRequest("/api/v1/billing/checkout", { interval: "month" }),
    db,
    hostedEnv,
    creem,
    user,
  );
  expect(monthly.status).toBe(200);
  expect(await monthly.json()).toEqual({
    checkoutUrl: "https://creem.io/checkout/cs_test",
    interval: "month",
    monthlyPriceCents: HOSTED_MONTHLY_PRICE_CENTS,
    annualPriceCents: HOSTED_ANNUAL_PRICE_CENTS,
  });
  expect(HOSTED_MONTHLY_PRICE_CENTS).toBe(599);
  expect(HOSTED_ANNUAL_PRICE_CENTS).toBe(5990);

  const annual = await handleBillingCheckout(
    jsonRequest("/api/v1/billing/checkout", { interval: "year" }),
    db,
    hostedEnv,
    creem,
    user,
  );
  expect(annual.status).toBe(200);
  expect(checkouts).toEqual([
    {
      productId: "prod_month",
      customer: { email: "ada@example.com", name: "Ada" },
      successUrl: "https://corotum.com/dashboard/billing",
      metadata: { userId: "user_1", billingInterval: "month" },
    },
    {
      productId: "prod_year",
      customer: { email: "ada@example.com", name: "Ada" },
      successUrl: "https://corotum.com/dashboard/billing",
      metadata: { userId: "user_1", billingInterval: "year" },
    },
  ]);
});

test("billing portal opens only the authenticated customer's Creem portal", async () => {
  const { db } = await billingDb();
  const { creem, portals } = mockCreem();
  const payload = JSON.stringify({
    id: "evt_paid_1",
    eventType: "subscription.paid",
    object: {
      id: "sub_creem_1",
      status: "active",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1", billingInterval: "month" },
    },
  });
  const webhook = await handleCreemWebhook(
    new Request("https://corotum.com/api/v1/webhooks/creem", {
      method: "POST",
      headers: {
        "creem-signature": await sign(payload, webhookSecret),
      },
      body: payload,
    }),
    db,
    hostedEnv,
  );
  expect(webhook.status).toBe(200);

  const denied = await handleBillingPortal(
    jsonRequest("/api/v1/billing/portal", {}),
    db,
    hostedEnv,
    creem,
    { id: "user_missing", email: "other@example.com" },
  );
  expect(denied.status).toBe(404);

  const portal = await handleBillingPortal(
    jsonRequest("/api/v1/billing/portal", {}),
    db,
    hostedEnv,
    creem,
    { id: "user_1", email: "ada@example.com" },
  );
  expect(portal.status).toBe(200);
  expect(await portal.json()).toEqual({
    portalUrl: "https://creem.io/portal/cus_ada",
  });
  expect(portals).toEqual(["cus_ada"]);
});

test("only a verified Creem webhook grants or revokes hosted entitlement, and duplicate ids are ignored", async () => {
  const { sqlite, db } = await billingDb();
  const checkoutCompleted = JSON.stringify({
    id: "evt_checkout_1",
    eventType: "checkout.completed",
    object: {
      id: "chk_1",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1" },
    },
  });
  await processCreemWebhook(
    db,
    hostedEnv,
    checkoutCompleted,
    await sign(checkoutCompleted, webhookSecret),
  );
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);

  const payload = JSON.stringify({
    id: "evt_paid_dup",
    eventType: "subscription.paid",
    object: {
      id: "sub_creem_2",
      customer: "cus_ada",
      metadata: { userId: "user_1", billingInterval: "year" },
    },
  });
  const signature = await sign(payload, webhookSecret);
  expect(await verifyCreemSignature(payload, "deadbeef", webhookSecret)).toBe(
    false,
  );

  const invalid = await handleCreemWebhook(
    new Request("https://corotum.com/api/v1/webhooks/creem", {
      method: "POST",
      headers: { "creem-signature": "nope" },
      body: payload,
    }),
    db,
    hostedEnv,
  );
  expect(invalid.status).toBe(401);
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);

  const first = await processCreemWebhook(
    db,
    hostedEnv,
    payload,
    signature,
    1_000,
  );
  expect(first).toEqual({ duplicate: false, eventType: "subscription.paid" });
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(true);

  sqlite
    .query("UPDATE subscriptions SET status = 'canceled', updated_at = ?")
    .run(2_000);
  const duplicate = await processCreemWebhook(
    db,
    hostedEnv,
    payload,
    signature,
    3_000,
  );
  expect(duplicate).toEqual({
    duplicate: true,
    eventType: "subscription.paid",
  });
  expect(
    sqlite
      .query("SELECT status, updated_at AS updatedAt FROM subscriptions")
      .get(),
  ).toEqual({ status: "canceled", updatedAt: 2_000 });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 2 });

  const canceled = JSON.stringify({
    id: "evt_cancel_1",
    eventType: "subscription.canceled",
    object: {
      id: "sub_creem_2",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1" },
    },
  });
  await processCreemWebhook(
    db,
    hostedEnv,
    canceled,
    await sign(canceled, webhookSecret),
    4_000,
  );
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
});

test("the launch period ends at midnight UTC and then requires a subscription", async () => {
  const { db } = await billingDb();
  expect(isLaunchFreePeriod(launchEnd - 1)).toBe(true);
  expect(isLaunchFreePeriod(launchEnd)).toBe(false);
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd - 1)).toBe(true);
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
});

test("login and pairing work without entitlement while hosted sync and mutations are denied", async () => {
  const { sqlite, db } = await billingDb();
  const created = await handleCreatePairing(
    jsonRequest("/api/v1/cli/pairings", device, {
      headers: {
        origin: "https://corotum.com",
        "content-type": "application/json",
        [CLI_VERSION_HEADER]: "0.1.0",
      },
    }),
    db,
  );
  expect(created.status).toBe(201);
  const pairing = (await created.json()) as {
    id: string;
    userCode: string;
    deviceCode: string;
  };
  await approvePairing(db, "user_1", pairing.id, pairing.userCode, 2_000);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );
  const workspaceId = issued.workspaceId as string;

  const pull = await afterLaunch(() => handleGetWorkspaceState(
    new Request(
      `https://corotum.com/api/v1/workspaces/${workspaceId}/state`,
      {
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          "x-toolmirror-device-token": issued.token,
        },
      },
    ),
    db,
    workspaceId,
    true,
  ));
  expect(pull.status).toBe(402);

  const push = await afterLaunch(() => handlePutWorkspaceState(
    new Request(
      `https://corotum.com/api/v1/workspaces/${workspaceId}/state`,
      {
        method: "PUT",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          "x-toolmirror-device-token": issued.token,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
    db,
    workspaceId,
    true,
  ));
  expect(push.status).toBe(402);

  const grant = JSON.stringify({
    id: "evt_grant_sync",
    eventType: "subscription.active",
    object: {
      id: "sub_sync",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1", billingInterval: "month" },
    },
  });
  await processCreemWebhook(
    db,
    hostedEnv,
    grant,
    await sign(grant, webhookSecret),
  );
  const entitled = await handleGetWorkspaceState(
    new Request(
      `https://corotum.com/api/v1/workspaces/${workspaceId}/state`,
      {
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          "x-toolmirror-device-token": issued.token,
        },
      },
    ),
    db,
    workspaceId,
    true,
  );
  expect(entitled.status).toBe(200);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM devices").get()).toEqual({
    count: 1,
  });
});

test("self-hosted Cloud does not require Creem entitlement", async () => {
  const { db } = await billingDb();
  const { creem } = mockCreem();
  expect(await hasHostedCloudAccess(db, "user_1", false)).toBe(true);

  const checkout = await handleBillingCheckout(
    jsonRequest("/api/v1/billing/checkout", { interval: "month" }),
    db,
    selfHostedEnv,
    creem,
    { id: "user_1", email: "ada@example.com" },
  );
  expect(checkout.status).toBe(404);
  const webhook = await handleCreemWebhook(
    new Request("https://selfhost.example/api/v1/webhooks/creem", {
      method: "POST",
      body: "{}",
    }),
    db,
    selfHostedEnv,
  );
  expect(webhook.status).toBe(404);

  const pairing = await createPairing(db, device, 1_000);
  await approvePairing(db, "user_1", pairing.id, pairing.userCode, 2_000);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );
  const workspaceId = issued.workspaceId as string;
  const pull = await handleGetWorkspaceState(
    new Request(
      `https://corotum.com/api/v1/workspaces/${workspaceId}/state`,
      {
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          "x-toolmirror-device-token": issued.token,
        },
      },
    ),
    db,
    workspaceId,
    false,
  );
  expect(pull.status).toBe(200);
});
