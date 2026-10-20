import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth";
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
  readHostedCloudAccess,
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
const launchEnd = Date.parse("2026-10-22T00:00:00.000Z");

async function afterLaunch<T>(run: () => Promise<T>) {
  const now = Date.now;
  Date.now = () => launchEnd;
  try {
    return await run();
  } finally {
    Date.now = now;
  }
}

async function billingDb(files = migrationFiles) {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  let batches = Promise.resolve();
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
      const run = batches.then(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements)
            results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
      batches = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
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

const day = 86_400_000;
function lifecycleEvent(
  type: string,
  time = launchEnd + 1_000,
  changes: Record<string, unknown> = {},
) {
  const object = {
    id: "sub_lifecycle",
    created_at: launchEnd - day,
    product: "prod_month",
    customer: "cus_ada",
    current_period_start_date: new Date(launchEnd - day).toISOString(),
    current_period_end_date: new Date(launchEnd + day).toISOString(),
    metadata: { userId: "user_1" },
    ...changes,
  };
  return {
    id: `evt_${type}_${time}`,
    eventType: type,
    created_at: time,
    object:
      type === "checkout.completed"
        ? {
            id: "ch_lifecycle",
            product: object.product,
            customer: object.customer,
            metadata: object.metadata,
            subscription: object,
          }
        : object,
  };
}
async function deliver(
  db: BillingDatabase,
  event: ReturnType<typeof lifecycleEvent>,
) {
  const payload = JSON.stringify(event);
  return processCreemWebhook(
    db,
    hostedEnv,
    payload,
    await sign(payload, webhookSecret),
    launchEnd + 2_000,
  );
}

test("all eleven lifecycle events update state with bounded access", async () => {
  for (const [type, status, allowed] of [
    ["paid", "active", true],
    ["active", "active", true],
    ["trialing", "trialing", true],
    ["scheduled_cancel", "scheduled_cancel", true],
    ["past_due", "past_due", true],
    ["unpaid", "unpaid", false],
    ["paused", "paused", false],
    ["expired", "expired", false],
    ["canceled", "canceled", false],
    ["update", "paused", false],
  ] as const) {
    const { db, sqlite } = await billingDb();
    await deliver(db, lifecycleEvent("subscription.paid", launchEnd));
    const event = lifecycleEvent(
      `subscription.${type}`,
      launchEnd + 1_000,
      type === "update" ? { status: "paused" } : {},
    );
    await deliver(db, event);
    expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
      status,
    });
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 2_000),
    ).toBe(allowed);
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 5 * day),
    ).toBe(false);
    expect((await deliver(db, event)).duplicate).toBe(true);
  }
  const { db, sqlite } = await billingDb();
  await deliver(db, lifecycleEvent("checkout.completed"));
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 2_000),
  ).toBe(false);
  expect(
    sqlite.query("SELECT user_id FROM billing_subscription_links").get(),
  ).toEqual({ user_id: "user_1" });
  await deliver(
    db,
    lifecycleEvent("subscription.active", launchEnd + 3_000, { metadata: {} }),
  );
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 4_000),
  ).toBe(true);
});

test("product and identity validation fail closed without consuming events", async () => {
  const { db, sqlite } = await billingDb();
  for (const changes of [
    { product: "prod_other" },
    { product: null },
    { metadata: {} },
    { metadata: { userId: "missing" } },
    { metadata: { userId: "user_1", user_id: "other" } },
  ]) {
    await expect(
      deliver(db, lifecycleEvent("subscription.paid", launchEnd, changes)),
    ).rejects.toThrow();
  }
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 0 });
  await deliver(db, lifecycleEvent("subscription.paid", launchEnd));
  await expect(
    deliver(
      db,
      lifecycleEvent("subscription.paid", launchEnd + 1_000, {
        customer: "cus_other",
      }),
    ),
  ).rejects.toThrow();
  await expect(
    deliver(
      db,
      lifecycleEvent("subscription.active", launchEnd + 1_000, {
        metadata: { userId: "other" },
      }),
    ),
  ).rejects.toThrow();
});

test("event recording failure rolls back the subscription and link writes", async () => {
  const { db, sqlite } = await billingDb();
  sqlite.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON billing_events BEGIN SELECT RAISE(ABORT, 'event failure'); END",
  );
  await expect(
    deliver(db, lifecycleEvent("subscription.paid")),
  ).rejects.toThrow("event failure");
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM subscriptions").get(),
  ).toEqual({ count: 0 });
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM billing_subscription_links")
      .get(),
  ).toEqual({ count: 0 });
});

test("access boundaries and fixed grace period do not depend on a final webhook", async () => {
  const { db } = await billingDb();
  await deliver(db, lifecycleEvent("subscription.paid", launchEnd));
  expect(
    await readHostedCloudAccess(db, "user_1", true, launchEnd + day - 1),
  ).toEqual({ allowed: true, expiresAt: launchEnd + day });
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd + day)).toBe(
    false,
  );
  await deliver(db, lifecycleEvent("subscription.past_due", launchEnd + day));
  await deliver(
    db,
    lifecycleEvent("subscription.past_due", launchEnd + 2 * day),
  );
  expect(
    await readHostedCloudAccess(db, "user_1", true, launchEnd + 3 * day),
  ).toEqual({ allowed: true, expiresAt: launchEnd + 4 * day });
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 4 * day),
  ).toBe(false);
});

test("concurrent duplicate deliveries commit state once and invalidate only after commit", async () => {
  const { db, sqlite } = await billingDb();
  const invalidations: string[] = [];
  const hooked = {
    ...db,
    async invalidateEvents(scope: { userId: string } | { deviceId: string }) {
      expect(
        sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
      ).toEqual({ count: 1 });
      if ("userId" in scope) invalidations.push(scope.userId);
    },
  };
  const event = lifecycleEvent("subscription.paid");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => deliver(hooked, event)),
  );
  expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  expect(invalidations).toEqual(["user_1"]);
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM billing_subscription_links")
      .get(),
  ).toEqual({ count: 1 });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM subscriptions").get(),
  ).toEqual({ count: 1 });
});

test("concurrent customer ownership claims cannot attach the same customer to two users", async () => {
  const { db, sqlite } = await billingDb();
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('user_2', 'Other', 'other@example.com', 1, 1, 1)`);
  const results = await Promise.allSettled([
    deliver(db, lifecycleEvent("subscription.paid", launchEnd + 1_000)),
    deliver(
      db,
      lifecycleEvent("subscription.paid", launchEnd + 2_000, {
        id: "sub_other",
        metadata: { userId: "user_2" },
      }),
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 1 });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM subscriptions").get(),
  ).toEqual({ count: 1 });
});

test("concurrent subscription identity conflicts roll back the losing event", async () => {
  const { db, sqlite } = await billingDb();
  const results = await Promise.allSettled([
    deliver(db, lifecycleEvent("subscription.paid", launchEnd + 1_000)),
    deliver(
      db,
      lifecycleEvent("subscription.paid", launchEnd + 2_000, {
        customer: "cus_other",
      }),
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 1 });
});

test("state write failures roll back the event and identity link and can be retried", async () => {
  const { db, sqlite } = await billingDb();
  const invalidations: unknown[] = [];
  const hooked = {
    ...db,
    async invalidateEvents(scope: unknown) {
      invalidations.push(scope);
    },
  };
  sqlite.exec(
    "CREATE TRIGGER fail_state BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'state failure'); END",
  );
  const event = lifecycleEvent("subscription.paid");
  await expect(deliver(hooked, event)).rejects.toThrow("state failure");
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 0 });
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM billing_subscription_links")
      .get(),
  ).toEqual({ count: 0 });
  expect(invalidations).toHaveLength(0);
  sqlite.exec("DROP TRIGGER fail_state");
  expect((await deliver(hooked, event)).duplicate).toBe(false);
  expect((await deliver(hooked, event)).duplicate).toBe(true);
  expect(invalidations).toHaveLength(1);
});

test("failure after the state insert rolls back every write in the batch", async () => {
  const { db, sqlite } = await billingDb();
  sqlite.exec(
    "CREATE TRIGGER fail_evidence BEFORE UPDATE ON subscriptions BEGIN SELECT RAISE(ABORT, 'evidence failure'); END",
  );
  await expect(
    deliver(db, lifecycleEvent("subscription.paid")),
  ).rejects.toThrow("evidence failure");
  for (const table of [
    "billing_events",
    "billing_subscription_links",
    "subscriptions",
  ]) {
    expect(
      sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ).toEqual({ count: 0 });
  }
});

test("an unsuccessful batch result cannot acknowledge successful webhook processing", async () => {
  const { db } = await billingDb();
  await expect(
    deliver(
      {
        ...db,
        async batch(statements) {
          return statements.map(() => ({ success: false }));
        },
      },
      lifecycleEvent("subscription.paid"),
    ),
  ).rejects.toThrow();
  await expect(
    deliver({ ...db, batch: undefined }, lifecycleEvent("subscription.paid")),
  ).rejects.toThrow("Atomic");
});

test("pause, recovery, plan updates and scheduled cancellation resume in provider order", async () => {
  const { db, sqlite } = await billingDb();
  await deliver(db, lifecycleEvent("subscription.paid", launchEnd));
  await deliver(db, lifecycleEvent("subscription.paused", launchEnd + 2_000));
  await deliver(db, lifecycleEvent("subscription.active", launchEnd + 1_000));
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 3_000),
  ).toBe(false);
  await deliver(
    db,
    lifecycleEvent("subscription.active", launchEnd + 4_000, { metadata: {} }),
  );
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 5_000),
  ).toBe(true);
  await deliver(
    db,
    lifecycleEvent("subscription.update", launchEnd + 6_000, {
      product: "prod_year",
      status: "scheduled_cancel",
      metadata: {},
      current_period_end_date: new Date(launchEnd + 2 * day).toISOString(),
    }),
  );
  expect(
    sqlite.query("SELECT billing_interval, status FROM subscriptions").get(),
  ).toEqual({ billing_interval: "year", status: "scheduled_cancel" });
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 2 * day),
  ).toBe(false);
  await deliver(db, lifecycleEvent("checkout.completed", launchEnd + 7_000));
  expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
    status: "scheduled_cancel",
  });
  await deliver(db, lifecycleEvent("subscription.unpaid", launchEnd + 8_000));
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 9_000),
  ).toBe(false);
  await deliver(db, lifecycleEvent("subscription.paid", launchEnd + 10_000));
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 11_000),
  ).toBe(true);
});

test("trial, missing dates, future periods and first-charge failure fail closed at boundaries", async () => {
  for (const [type, changes] of [
    ["subscription.active", { current_period_end_date: null }],
    [
      "subscription.active",
      {
        current_period_start_date: new Date(launchEnd + day / 2).toISOString(),
      },
    ],
    ["subscription.past_due", {}],
  ] as const) {
    const { db } = await billingDb();
    await deliver(db, lifecycleEvent(type, launchEnd, changes));
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 1_000),
    ).toBe(false);
  }
  const { db } = await billingDb();
  await deliver(
    db,
    lifecycleEvent("subscription.trialing", launchEnd, {
      trial_end_date: new Date(launchEnd + 10_000).toISOString(),
    }),
  );
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 9_999),
  ).toBe(true);
  expect(
    await hasHostedCloudAccess(db, "user_1", true, launchEnd + 10_000),
  ).toBe(false);
  await expect(
    deliver(
      db,
      lifecycleEvent("subscription.update", launchEnd + 1_000, {
        status: "active",
        current_period_end_date: "invalid",
      }),
    ),
  ).rejects.toThrow();
});

test("late payment evidence enriches a newer date-less status without reviving revoked access", async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    for (const offset of [0, 1_000]) {
      const { db, sqlite } = await billingDb();
      const paid = lifecycleEvent("subscription.paid", launchEnd);
      const active = lifecycleEvent("subscription.active", launchEnd + offset, {
        current_period_start_date: null,
        current_period_end_date: null,
      });
      for (const index of order) await deliver(db, [paid, active][index]);
      expect(
        await hasHostedCloudAccess(db, "user_1", true, launchEnd + 2_000),
      ).toBe(true);
      expect(
        sqlite
          .query("SELECT current_period_end AS end FROM subscriptions")
          .get(),
      ).toEqual({ end: launchEnd + day });
      await deliver(
        db,
        lifecycleEvent("subscription.paused", launchEnd + 5_000),
      );
      await deliver(db, lifecycleEvent("subscription.paid", launchEnd + 4_000));
      expect(
        await hasHostedCloudAccess(db, "user_1", true, launchEnd + 6_000),
      ).toBe(false);
    }
  }
});

test("payment and past-due delivery order produces the same fixed grace deadline", async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const { db } = await billingDb();
    const events = [
      lifecycleEvent("subscription.paid", launchEnd),
      lifecycleEvent("subscription.past_due", launchEnd + day),
    ];
    for (const index of order) await deliver(db, events[index]);
    expect(
      await readHostedCloudAccess(db, "user_1", true, launchEnd + 2 * day),
    ).toEqual({ allowed: true, expiresAt: launchEnd + 4 * day });
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 4 * day),
    ).toBe(false);
  }
});

test("late recovery between two payment-failure cycles does not lose or extend the new grace period", async () => {
  for (const order of [
    [0, 1, 2, 3, 4],
    [0, 1, 3, 4, 2],
    [4, 3, 1, 2, 0],
  ]) {
    const { db } = await billingDb();
    const events = [
      lifecycleEvent("subscription.paid", launchEnd),
      lifecycleEvent("subscription.past_due", launchEnd + day),
      lifecycleEvent("subscription.paid", launchEnd + 2 * day, {
        current_period_end_date: new Date(launchEnd + 3 * day).toISOString(),
      }),
      lifecycleEvent("subscription.past_due", launchEnd + 3 * day),
      lifecycleEvent("subscription.past_due", launchEnd + 4 * day),
    ];
    for (const index of order) await deliver(db, events[index]);
    expect(
      await readHostedCloudAccess(db, "user_1", true, launchEnd + 5 * day),
    ).toEqual({ allowed: true, expiresAt: launchEnd + 6 * day });
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 6 * day),
    ).toBe(false);
  }
});

test("newer or equal end-only snapshots accept missing start evidence without regressing their end", async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    for (const offset of [0, 1_000]) {
      const { db } = await billingDb();
      const events = [
        lifecycleEvent("subscription.paid", launchEnd),
        lifecycleEvent("subscription.active", launchEnd + offset, {
          current_period_start_date: null,
        }),
      ];
      for (const index of order) await deliver(db, events[index]);
      expect(
        await hasHostedCloudAccess(db, "user_1", true, launchEnd + 2_000),
      ).toBe(true);
    }
  }
});

test("equal-timestamp payment and failure preserve bounded grace in either delivery order", async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const { db } = await billingDb();
    const events = [
      lifecycleEvent("subscription.paid", launchEnd),
      lifecycleEvent("subscription.past_due", launchEnd),
    ];
    for (const index of order) await deliver(db, events[index]);
    expect(
      await readHostedCloudAccess(db, "user_1", true, launchEnd + 2 * day),
    ).toEqual({ allowed: true, expiresAt: launchEnd + 3 * day });
    expect(
      await hasHostedCloudAccess(db, "user_1", true, launchEnd + 3 * day),
    ).toBe(false);
  }
});

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
    created_at: 1_000,
    object: {
      id: "sub_creem_1",
      created_at: 100,
      product: "prod_month",
      current_period_start: launchEnd - day,
      current_period_end: launchEnd + day,
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
    created_at: 500,
    object: {
      id: "chk_1",
      product: "prod_year",
      subscription: "sub_creem_2",
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
    created_at: 1_000,
    object: {
      id: "sub_creem_2",
      created_at: 100,
      product: "prod_year",
      current_period_start: launchEnd - day,
      current_period_end: launchEnd + day,
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

  const expired = JSON.stringify({
    id: "evt_expired_1",
    eventType: "subscription.expired",
    created_at: 1_500,
    object: {
      id: "sub_creem_2",
      product: "prod_year",
      customer: { id: "cus_ada" },
    },
  });
  await processCreemWebhook(
    db,
    hostedEnv,
    expired,
    await sign(expired, webhookSecret),
    1_500,
  );
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);

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
  ).toEqual({ count: 3 });

  const canceled = JSON.stringify({
    id: "evt_cancel_1",
    eventType: "subscription.canceled",
    created_at: 4_000,
    object: {
      id: "sub_creem_2",
      created_at: 100,
      product: "prod_year",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1" },
    },
  });
  const invalidated: unknown[] = [];
  await processCreemWebhook(
    {
      ...db,
      async invalidateEvents(scope) {
        expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(
          false,
        );
        invalidated.push(scope);
      },
    },
    hostedEnv,
    canceled,
    await sign(canceled, webhookSecret),
    4_000,
  );
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
  expect(invalidated).toEqual([{ userId: "user_1" }]);
});

test("unbound subscription.active without metadata is rejected without granting access", async () => {
  const { db } = await billingDb();
  const payload = JSON.stringify({
    id: "evt_active_1",
    eventType: "subscription.active",
    object: { id: "sub_creem_3", customer: { id: "cus_ada" } },
  });

  await expect(
    processCreemWebhook(
      db,
      hostedEnv,
      payload,
      await sign(payload, webhookSecret),
    ),
  ).rejects.toThrow();
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
});

test("the launch period ends at midnight UTC and then requires a subscription", async () => {
  const { db } = await billingDb();
  expect(isLaunchFreePeriod(Date.parse("2026-10-01T00:00:00.000Z"))).toBe(true);
  expect(isLaunchFreePeriod(Date.parse("2026-10-15T00:00:00.000Z"))).toBe(true);
  expect(isLaunchFreePeriod(launchEnd - 1)).toBe(true);
  expect(isLaunchFreePeriod(launchEnd)).toBe(false);
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd - 1)).toBe(
    true,
  );
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
});

async function subscriptionEvent(
  db: BillingDatabase,
  eventId: string,
  eventType: string,
  eventTime: number,
  subscriptionId = "sub_current",
  subscriptionCreatedAt = 100,
) {
  const payload = JSON.stringify({
    id: eventId,
    eventType,
    created_at: eventTime,
    object: {
      id: subscriptionId,
      created_at: subscriptionCreatedAt,
      product: "prod_year",
      current_period_start: launchEnd - day,
      current_period_end: launchEnd + day,
      customer: "cus_ada",
      metadata: { userId: "user_1", billingInterval: "year" },
    },
  });
  return processCreemWebhook(
    db,
    hostedEnv,
    payload,
    await sign(payload, webhookSecret),
  );
}

test("active subscriptions cannot purchase another plan", async () => {
  const { db } = await billingDb();
  await subscriptionEvent(db, "evt_paid", "subscription.paid", 1_000);
  const { creem, checkouts } = mockCreem();
  const response = await handleBillingCheckout(
    jsonRequest("/api/v1/billing/checkout", { interval: "month" }),
    db,
    hostedEnv,
    creem,
    { id: "user_1", email: "ada@example.com" },
  );
  expect(response.status).toBe(409);
  expect(checkouts).toHaveLength(0);
});

test("hosted account deletion is blocked until the subscription is canceled", async () => {
  const { db } = await billingDb();
  const auth = createAuth({
    DB: db as unknown as D1Database,
    COROTUM_HOSTED: "true",
    BETTER_AUTH_SECRET: "a-secure-secret-with-at-least-thirty-two-characters",
    BETTER_AUTH_URL: "https://corotum.com",
  });
  const beforeDelete = auth.options.user?.deleteUser?.beforeDelete;
  expect(beforeDelete).toBeFunction();
  if (!beforeDelete)
    throw new Error("Account deletion must have a billing guard");
  const user = { id: "user_1" } as never;
  await beforeDelete(user, new Request("https://corotum.com"));
  await subscriptionEvent(db, "evt_paid", "subscription.paid", 1_000);
  await expect(
    beforeDelete(user, new Request("https://corotum.com")),
  ).rejects.toThrow("subscription");
  await subscriptionEvent(db, "evt_cancel", "subscription.canceled", 2_000);
  await beforeDelete(user, new Request("https://corotum.com"));
});

test("late paid events cannot restore a canceled subscription", async () => {
  const { sqlite, db } = await billingDb();
  await subscriptionEvent(db, "evt_cancel", "subscription.canceled", 2_000);
  await subscriptionEvent(db, "evt_old_paid", "subscription.paid", 1_000);
  expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
    status: "canceled",
  });
  await subscriptionEvent(db, "evt_later_paid", "subscription.paid", 3_000);
  expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
    status: "canceled",
  });
});

test("events for an old subscription cannot replace the newer subscription", async () => {
  const { sqlite, db } = await billingDb();
  await subscriptionEvent(
    db,
    "evt_new_paid",
    "subscription.paid",
    3_000,
    "sub_new",
    200,
  );
  await subscriptionEvent(
    db,
    "evt_old_cancel",
    "subscription.canceled",
    4_000,
    "sub_old",
    100,
  );
  await subscriptionEvent(
    db,
    "evt_old_paid",
    "subscription.paid",
    5_000,
    "sub_old",
    100,
  );
  expect(
    sqlite
      .query("SELECT status, provider_subscription_id AS id FROM subscriptions")
      .get(),
  ).toEqual({ status: "active", id: "sub_new" });
});

test("a newer subscription replaces a canceled one and older renewals are ignored", async () => {
  const { sqlite, db } = await billingDb();
  await subscriptionEvent(
    db,
    "evt_old_cancel",
    "subscription.canceled",
    2_000,
    "sub_old",
    100,
  );
  await subscriptionEvent(
    db,
    "evt_new_paid",
    "subscription.paid",
    3_000,
    "sub_new",
    200,
  );
  await subscriptionEvent(
    db,
    "evt_late_renewal",
    "subscription.paid",
    2_500,
    "sub_new",
    200,
  );
  expect(
    sqlite
      .query(
        "SELECT status, provider_subscription_id AS id, event_created_at AS eventTime FROM subscriptions",
      )
      .get(),
  ).toEqual({ status: "active", id: "sub_new", eventTime: 3_000 });
});

test("cancellation wins when provider event timestamps are equal", async () => {
  for (const order of [
    ["paid", "canceled"],
    ["canceled", "paid"],
  ]) {
    const { sqlite, db } = await billingDb();
    for (const type of order) {
      await subscriptionEvent(db, `evt_${type}`, `subscription.${type}`, 1_000);
    }
    expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
      status: "canceled",
    });
  }
});

test("concurrent old and new subscription events keep the newer subscription", async () => {
  const { sqlite, db } = await billingDb();
  await Promise.all([
    subscriptionEvent(
      db,
      "evt_old_paid",
      "subscription.paid",
      3_000,
      "sub_old",
      100,
    ),
    subscriptionEvent(
      db,
      "evt_new_paid",
      "subscription.paid",
      2_000,
      "sub_new",
      200,
    ),
    subscriptionEvent(
      db,
      "evt_old_cancel",
      "subscription.canceled",
      4_000,
      "sub_old",
      100,
    ),
  ]);
  expect(
    sqlite
      .query("SELECT status, provider_subscription_id AS id FROM subscriptions")
      .get(),
  ).toEqual({ status: "active", id: "sub_new" });
});

test("checkout stays blocked during payment recovery but allows canceled plans", async () => {
  const { sqlite, db } = await billingDb();
  await subscriptionEvent(db, "evt_paid", "subscription.paid", 1_000);
  const { creem, checkouts } = mockCreem();
  for (const status of ["trialing", "past_due", "paused", "scheduled_cancel"]) {
    sqlite.query("UPDATE subscriptions SET status = ?").run(status);
    const response = await handleBillingCheckout(
      jsonRequest("/api/v1/billing/checkout", { interval: "year" }),
      db,
      hostedEnv,
      creem,
      { id: "user_1", email: "ada@example.com" },
    );
    expect(response.status).toBe(409);
  }
  expect(checkouts).toHaveLength(0);
  await subscriptionEvent(db, "evt_cancel", "subscription.canceled", 2_000);
  const response = await handleBillingCheckout(
    jsonRequest("/api/v1/billing/checkout", { interval: "year" }),
    db,
    hostedEnv,
    creem,
    { id: "user_1", email: "ada@example.com" },
  );
  expect(response.status).toBe(200);
  expect(checkouts).toHaveLength(1);
});

test("the billing migration preserves existing plans and guards them against old subscriptions", async () => {
  const { sqlite, db } = await billingDb(
    migrationFiles.filter(
      (file) => !file.startsWith("0015_") && !file.startsWith("0016_"),
    ),
  );
  sqlite
    .query(`INSERT INTO subscriptions (
    id, user_id, provider, provider_customer_id, provider_subscription_id,
    billing_interval, status, created_at, updated_at
  ) VALUES ('sub_row', 'user_1', 'creem', 'cus_ada', 'sub_current', 'year', 'active', 1000, 2000)`)
    .run();
  sqlite.exec(
    await Bun.file(
      join(migrationsDirectory, "0015_billing_event_order.sql"),
    ).text(),
  );
  expect(
    sqlite
      .query(
        "SELECT event_created_at, subscription_created_at FROM subscriptions",
      )
      .get(),
  ).toEqual({ event_created_at: 2_000, subscription_created_at: 1_000 });
  sqlite.exec(
    await Bun.file(
      join(migrationsDirectory, "0016_billing_lifecycle.sql"),
    ).text(),
  );
  expect(
    sqlite.query("SELECT user_id FROM billing_subscription_links").get(),
  ).toEqual({ user_id: "user_1" });
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(false);
  await subscriptionEvent(
    db,
    "evt_old_cancel",
    "subscription.canceled",
    3_000,
    "sub_old",
    500,
  );
  await subscriptionEvent(
    db,
    "evt_current_paid",
    "subscription.paid",
    2_500,
    "sub_current",
    900,
  );
  expect(
    sqlite
      .query(
        "SELECT status, provider_subscription_id AS id, subscription_created_at AS createdAt FROM subscriptions",
      )
      .get(),
  ).toEqual({ status: "active", id: "sub_current", createdAt: 900 });
  expect(await hasHostedCloudAccess(db, "user_1", true, launchEnd)).toBe(true);
});

test("subscription webhooks require provider event and subscription creation timestamps", async () => {
  const { sqlite, db } = await billingDb();
  for (const payload of [
    {
      id: "evt_missing_time",
      eventType: "subscription.paid",
      object: {
        id: "sub_1",
        customer: "cus_ada",
        metadata: { userId: "user_1" },
      },
    },
    {
      id: "evt_missing_subscription_time",
      eventType: "subscription.paid",
      created_at: 1_000,
      object: {
        id: "sub_1",
        customer: "cus_ada",
        metadata: { userId: "user_1" },
      },
    },
  ]) {
    const body = JSON.stringify(payload);
    const response = await handleCreemWebhook(
      new Request("https://corotum.com/api/v1/webhooks/creem", {
        method: "POST",
        body,
        headers: { "creem-signature": await sign(body, webhookSecret) },
      }),
      db,
      hostedEnv,
    );
    expect(response.status).toBe(400);
  }
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM subscriptions").get(),
  ).toEqual({ count: 0 });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM billing_events").get(),
  ).toEqual({ count: 0 });
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

  const pull = await afterLaunch(() =>
    handleGetWorkspaceState(
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
    ),
  );
  expect(pull.status).toBe(402);

  const push = await afterLaunch(() =>
    handlePutWorkspaceState(
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
    ),
  );
  expect(push.status).toBe(402);

  const grant = JSON.stringify({
    id: "evt_grant_sync",
    eventType: "subscription.paid",
    created_at: 1_000,
    object: {
      id: "sub_sync",
      created_at: 100,
      product: "prod_month",
      current_period_start: launchEnd - day,
      current_period_end: launchEnd + day,
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
    new Request(`https://corotum.com/api/v1/workspaces/${workspaceId}/state`, {
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-token": issued.token,
      },
    }),
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
    new Request(`https://corotum.com/api/v1/workspaces/${workspaceId}/state`, {
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-token": issued.token,
      },
    }),
    db,
    workspaceId,
    false,
  );
  expect(pull.status).toBe(200);
});
