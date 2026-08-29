import type { WorkspaceDatabase } from "./workspaces";

export const CREEM_PROVIDER = "creem";
export const HOSTED_MONTHLY_PRICE_CENTS = 599;
export const HOSTED_ANNUAL_PRICE_CENTS = 5990;

export type BillingInterval = "month" | "year";
export type BillingDatabase = WorkspaceDatabase;

export type BillingEnvironment = {
  TOOLMIRROR_HOSTED?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PRODUCT_MONTHLY?: string;
  CREEM_PRODUCT_ANNUAL?: string;
  CREEM_API_URL?: string;
  BETTER_AUTH_URL?: string;
};

export type CreemCheckoutInput = Readonly<{
  productId: string;
  customPrice: number;
  customer: Readonly<{ email: string; name?: string }>;
  successUrl: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type CreemClient = {
  createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }>;
  createPortal(customerId: string): Promise<{ url: string }>;
};

const GRANT_EVENTS = new Set([
  "subscription.active",
  "subscription.trialing",
  "subscription.paid",
]);
const REVOKE_EVENTS = new Set([
  "subscription.paused",
  "subscription.expired",
  "subscription.canceled",
]);
const ENTITLED_STATUSES = new Set(["active", "trialing", "paid"]);

export class BillingNotConfiguredError extends Error {
  constructor() {
    super("Billing is not configured");
    this.name = "BillingNotConfiguredError";
  }
}

export class BillingUnavailableError extends Error {
  constructor() {
    super("Billing is not available on self-hosted Cloud");
    this.name = "BillingUnavailableError";
  }
}

export class BillingCustomerMissingError extends Error {
  constructor() {
    super("No billing customer");
    this.name = "BillingCustomerMissingError";
  }
}

export class InvalidBillingIntervalError extends Error {
  constructor() {
    super("A monthly or annual interval is required");
    this.name = "InvalidBillingIntervalError";
  }
}

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super("Invalid webhook signature");
    this.name = "InvalidWebhookSignatureError";
  }
}

export class UnprocessableWebhookError extends Error {
  constructor(message = "Webhook event cannot be applied") {
    super(message);
    this.name = "UnprocessableWebhookError";
  }
}

export class HostedEntitlementRequiredError extends Error {
  constructor() {
    super("Hosted Cloud subscription required");
    this.name = "HostedEntitlementRequiredError";
  }
}

export class CreemProviderError extends Error {
  constructor() {
    super("Checkout provider failed");
    this.name = "CreemProviderError";
  }
}

export function isHostedCloud(env: { TOOLMIRROR_HOSTED?: string }) {
  return env.TOOLMIRROR_HOSTED === "true" || env.TOOLMIRROR_HOSTED === "1";
}

export function hostedPriceCents(interval: BillingInterval) {
  return interval === "month"
    ? HOSTED_MONTHLY_PRICE_CENTS
    : HOSTED_ANNUAL_PRICE_CENTS;
}

export async function hasHostedCloudAccess(
  db: BillingDatabase,
  userId: string,
  hosted: boolean,
) {
  if (!hosted) return true;
  const row = await db
    .prepare("SELECT status FROM subscriptions WHERE user_id = ?")
    .bind(userId)
    .first<{ status: string }>();
  return Boolean(row && ENTITLED_STATUSES.has(row.status));
}

export async function requireHostedCloudAccess(
  db: BillingDatabase,
  userId: string,
  hosted: boolean,
) {
  if (await hasHostedCloudAccess(db, userId, hosted)) return;
  throw new HostedEntitlementRequiredError();
}

function productIdFor(env: BillingEnvironment, interval: BillingInterval) {
  return interval === "month"
    ? env.CREEM_PRODUCT_MONTHLY
    : env.CREEM_PRODUCT_ANNUAL;
}

export async function createHostedCheckout(
  env: BillingEnvironment,
  creem: CreemClient,
  input: {
    userId: string;
    email: string;
    name?: string;
    interval: unknown;
    successUrl: string;
  },
) {
  if (!isHostedCloud(env)) throw new BillingUnavailableError();
  const interval = parseInterval(input.interval);
  if (!env.CREEM_API_KEY || !productIdFor(env, interval)) {
    throw new BillingNotConfiguredError();
  }
  const checkout = await creem.createCheckout({
    productId: productIdFor(env, interval) as string,
    customPrice: hostedPriceCents(interval),
    customer: { email: input.email, name: input.name },
    successUrl: input.successUrl,
    metadata: { userId: input.userId, billingInterval: interval },
  });
  return { checkoutUrl: checkout.checkoutUrl, interval };
}

export async function createHostedPortal(
  db: BillingDatabase,
  env: BillingEnvironment,
  creem: CreemClient,
  userId: string,
) {
  if (!isHostedCloud(env)) throw new BillingUnavailableError();
  if (!env.CREEM_API_KEY) throw new BillingNotConfiguredError();
  const row = await db
    .prepare(
      "SELECT provider_customer_id AS customerId FROM subscriptions WHERE user_id = ?",
    )
    .bind(userId)
    .first<{ customerId: string }>();
  if (!row?.customerId) throw new BillingCustomerMissingError();
  return creem.createPortal(row.customerId);
}

export async function verifyCreemSignature(
  payload: string,
  signature: string | null,
  secret: string,
) {
  if (!signature) return false;
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
  const computed = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hexesMatch(computed, signature.trim().toLowerCase());
}

export async function processCreemWebhook(
  db: BillingDatabase,
  env: BillingEnvironment,
  payload: string,
  signature: string | null,
  now = Date.now(),
) {
  if (!isHostedCloud(env)) throw new BillingUnavailableError();
  if (!env.CREEM_WEBHOOK_SECRET) throw new BillingNotConfiguredError();
  if (
    !(await verifyCreemSignature(payload, signature, env.CREEM_WEBHOOK_SECRET))
  ) {
    throw new InvalidWebhookSignatureError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new UnprocessableWebhookError("Invalid webhook payload");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new UnprocessableWebhookError("Invalid webhook payload");
  }
  const event = parsed as {
    id?: unknown;
    eventType?: unknown;
    event_type?: unknown;
    object?: unknown;
  };
  const providerEventId = typeof event.id === "string" ? event.id.trim() : "";
  const eventType =
    (typeof event.eventType === "string" && event.eventType) ||
    (typeof event.event_type === "string" && event.event_type) ||
    "";
  if (!providerEventId || !eventType) {
    throw new UnprocessableWebhookError("Webhook event is missing an id");
  }

  const existing = await db
    .prepare(
      "SELECT provider_event_id AS providerEventId FROM billing_events WHERE provider = ? AND provider_event_id = ?",
    )
    .bind(CREEM_PROVIDER, providerEventId)
    .first<{ providerEventId: string }>();
  if (existing) return { duplicate: true as const, eventType };

  if (GRANT_EVENTS.has(eventType) || REVOKE_EVENTS.has(eventType)) {
    await applySubscriptionEvent(
      db,
      eventType,
      event.object,
      now,
      GRANT_EVENTS.has(eventType) ? "grant" : "revoke",
    );
  }

  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO billing_events (id, provider, provider_event_id, event_type, processed_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      `bev_${crypto.randomUUID()}`,
      CREEM_PROVIDER,
      providerEventId,
      eventType,
      now,
    )
    .run();
  if ((inserted as { meta?: { changes?: number } }).meta?.changes !== 1) {
    return { duplicate: true as const, eventType };
  }
  return { duplicate: false as const, eventType };
}

export function createCreemClient(env: BillingEnvironment): CreemClient {
  const base = (env.CREEM_API_URL ?? "https://api.creem.io").replace(/\/$/, "");
  return {
    async createCheckout(input) {
      const response = await fetch(`${base}/v1/checkouts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.CREEM_API_KEY ?? "",
        },
        body: JSON.stringify({
          product_id: input.productId,
          custom_price: input.customPrice,
          success_url: input.successUrl,
          customer: {
            email: input.customer.email,
            ...(input.customer.name ? { name: input.customer.name } : {}),
          },
          metadata: input.metadata,
        }),
      });
      if (!response.ok) throw new CreemProviderError();
      const body = (await response.json()) as {
        checkout_url?: unknown;
        url?: unknown;
      };
      const checkoutUrl =
        (typeof body.checkout_url === "string" && body.checkout_url) ||
        (typeof body.url === "string" && body.url) ||
        "";
      if (!checkoutUrl) throw new CreemProviderError();
      return { checkoutUrl };
    },
    async createPortal(customerId) {
      const response = await fetch(`${base}/v1/customers/billing`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.CREEM_API_KEY ?? "",
        },
        body: JSON.stringify({ customer_id: customerId }),
      });
      if (!response.ok) throw new CreemProviderError();
      const body = (await response.json()) as {
        customer_portal_link?: unknown;
        url?: unknown;
      };
      const url =
        (typeof body.customer_portal_link === "string" &&
          body.customer_portal_link) ||
        (typeof body.url === "string" && body.url) ||
        "";
      if (!url) throw new CreemProviderError();
      return { url };
    },
  };
}

function parseInterval(value: unknown): BillingInterval {
  if (value === "month" || value === "year") return value;
  throw new InvalidBillingIntervalError();
}

function hexesMatch(left: string, right: string) {
  if (left.length !== right.length) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function metadataOf(object: Record<string, unknown>) {
  return readObject(object.metadata) ?? {};
}

function customerIdOf(object: Record<string, unknown>) {
  const customer = object.customer;
  if (typeof customer === "string") return customer.trim();
  const nested = readObject(customer);
  return nested ? readString(nested.id) : "";
}

function intervalOf(
  object: Record<string, unknown>,
  fallback: BillingInterval,
): BillingInterval {
  const metadata = metadataOf(object);
  const billed = readString(metadata.billingInterval);
  if (billed === "month" || billed === "year") return billed;
  return fallback;
}

function timestampOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

async function applySubscriptionEvent(
  db: BillingDatabase,
  eventType: string,
  objectValue: unknown,
  now: number,
  action: "grant" | "revoke",
) {
  const object = readObject(objectValue);
  if (!object) throw new UnprocessableWebhookError();
  const metadata = metadataOf(object);
  const subscriptionId = readString(object.id);
  const customerId = customerIdOf(object);
  let userId =
    readString(metadata.userId) || readString(metadata.user_id) || "";
  if (!userId && customerId) {
    const existing = await db
      .prepare(
        "SELECT user_id AS userId FROM subscriptions WHERE provider_customer_id = ?",
      )
      .bind(customerId)
      .first<{ userId: string }>();
    userId = existing?.userId ?? "";
  }
  if (!userId && subscriptionId) {
    const existing = await db
      .prepare(
        "SELECT user_id AS userId FROM subscriptions WHERE provider_subscription_id = ?",
      )
      .bind(subscriptionId)
      .first<{ userId: string }>();
    userId = existing?.userId ?? "";
  }
  if (!userId || !subscriptionId || !customerId) {
    throw new UnprocessableWebhookError();
  }
  const user = await db
    .prepare("SELECT id FROM user WHERE id = ?")
    .bind(userId)
    .first<{ id: string }>();
  if (!user) throw new UnprocessableWebhookError();

  const status =
    action === "grant"
      ? grantedStatus(object, eventType)
      : eventStatus(eventType);
  const interval = intervalOf(object, "month");
  const periodStart =
    timestampOf(object.current_period_start) ??
    timestampOf(object.current_period_start_date);
  const periodEnd =
    timestampOf(object.current_period_end) ??
    timestampOf(object.current_period_end_date) ??
    timestampOf(object.next_transaction_date);

  await db
    .prepare(
      `INSERT INTO subscriptions (
          id, user_id, provider, provider_customer_id, provider_subscription_id,
          billing_interval, status, current_period_start, current_period_end,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          provider_customer_id = excluded.provider_customer_id,
          provider_subscription_id = excluded.provider_subscription_id,
          billing_interval = excluded.billing_interval,
          status = excluded.status,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          updated_at = excluded.updated_at`,
    )
    .bind(
      `sub_${crypto.randomUUID()}`,
      userId,
      CREEM_PROVIDER,
      customerId,
      subscriptionId,
      interval,
      status,
      periodStart,
      periodEnd,
      now,
      now,
    )
    .run();
}

function grantedStatus(object: Record<string, unknown>, eventType: string) {
  const status = readString(object.status);
  if (ENTITLED_STATUSES.has(status)) return status;
  if (eventType === "subscription.trialing") return "trialing";
  return "active";
}

function eventStatus(eventType: string) {
  if (eventType === "subscription.paused") return "paused";
  if (eventType === "subscription.expired") return "expired";
  return "canceled";
}
