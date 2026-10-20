import type { WorkspaceDatabase } from "./workspaces";

export const CREEM_PROVIDER = "creem";
export const HOSTED_MONTHLY_PRICE_CENTS = 599;
export const HOSTED_ANNUAL_PRICE_CENTS = 5990;
export const LAUNCH_FREE_PERIOD_END = "2026-10-22T00:00:00.000Z";

export type BillingInterval = "month" | "year";
export type BillingDatabase = WorkspaceDatabase & {
  batch?(
    statements: ReturnType<ReturnType<WorkspaceDatabase["prepare"]>["bind"]>[],
  ): Promise<readonly unknown[]>;
  invalidateEvents?(
    scope: { deviceId: string } | { userId: string },
  ): Promise<void>;
};

export type BillingEnvironment = {
  COROTUM_HOSTED?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PRODUCT_MONTHLY?: string;
  CREEM_PRODUCT_ANNUAL?: string;
  CREEM_API_URL?: string;
  BETTER_AUTH_URL?: string;
};

export type CreemCheckoutInput = Readonly<{
  productId: string;
  customer: Readonly<{ email: string; name?: string }>;
  successUrl: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type CreemClient = {
  createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }>;
  createPortal(customerId: string): Promise<{ url: string }>;
};

export const PAYMENT_GRACE_MS = 3 * 86_400_000;
const STATUSES = new Set([
  "active",
  "trialing",
  "scheduled_cancel",
  "past_due",
  "unpaid",
  "paused",
  "expired",
  "canceled",
]);
const EVENT_STATUS: Record<string, string> = {
  "subscription.paid": "active",
  "subscription.active": "active",
  "subscription.trialing": "trialing",
  "subscription.scheduled_cancel": "scheduled_cancel",
  "subscription.past_due": "past_due",
  "subscription.unpaid": "unpaid",
  "subscription.paused": "paused",
  "subscription.expired": "expired",
  "subscription.canceled": "canceled",
};
const STATUS_PRIORITY: Record<string, number> = {
  active: 20,
  trialing: 20,
  scheduled_cancel: 30,
  past_due: 40,
  unpaid: 50,
  paused: 60,
  expired: 80,
  canceled: 90,
};

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

export class BillingSubscriptionExistsError extends Error {
  constructor() {
    super(
      "Manage or cancel your existing subscription in Billing before continuing.",
    );
    this.name = "BillingSubscriptionExistsError";
  }
}

export async function requireNoBillableSubscription(
  db: BillingDatabase,
  userId: string,
  hosted: boolean,
) {
  if (!hosted) return;
  const subscription = await db
    .prepare("SELECT status FROM subscriptions WHERE user_id = ?")
    .bind(userId)
    .first<{ status: string }>();
  if (subscription && !["canceled", "expired"].includes(subscription.status)) {
    throw new BillingSubscriptionExistsError();
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

export function isHostedCloud(env: { COROTUM_HOSTED?: string }) {
  return env.COROTUM_HOSTED === "true" || env.COROTUM_HOSTED === "1";
}

export function hostedPriceCents(interval: BillingInterval) {
  return interval === "month"
    ? HOSTED_MONTHLY_PRICE_CENTS
    : HOSTED_ANNUAL_PRICE_CENTS;
}

export function isLaunchFreePeriod(now = Date.now()) {
  return now < Date.parse(LAUNCH_FREE_PERIOD_END);
}

export async function readHostedCloudAccess(
  db: BillingDatabase,
  userId: string,
  hosted: boolean,
  now = Date.now(),
) {
  if (!hosted) return { allowed: true, expiresAt: null };
  if (isLaunchFreePeriod(now))
    return { allowed: true, expiresAt: Date.parse(LAUNCH_FREE_PERIOD_END) };
  const row = await db
    .prepare(`SELECT status, provider_product_id AS productId, current_period_start AS periodStart,
      current_period_end AS periodEnd, trial_end AS trialEnd, grace_period_end AS graceEnd
      FROM subscriptions WHERE user_id = ?`)
    .bind(userId)
    .first<{
      status: string;
      productId: string | null;
      periodStart: number | null;
      periodEnd: number | null;
      trialEnd: number | null;
      graceEnd: number | null;
    }>();
  const end =
    row?.status === "trialing"
      ? row.trialEnd
      : row?.status === "past_due"
        ? row.graceEnd
        : row && ["active", "paid", "scheduled_cancel"].includes(row.status)
          ? row.periodEnd
          : null;
  const allowed = Boolean(
    row?.productId &&
      Number.isFinite(end) &&
      end !== null &&
      now < end &&
      row.periodStart !== null &&
      row.periodStart <= now &&
      row.periodStart < end,
  );
  return { allowed, expiresAt: allowed ? end : null };
}

export async function hasHostedCloudAccess(
  db: BillingDatabase,
  userId: string,
  hosted: boolean,
  now = Date.now(),
) {
  return (await readHostedCloudAccess(db, userId, hosted, now)).allowed;
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
  db: BillingDatabase,
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
  await requireNoBillableSubscription(db, input.userId, true);
  const interval = parseInterval(input.interval);
  if (!env.CREEM_API_KEY || !productIdFor(env, interval)) {
    throw new BillingNotConfiguredError();
  }
  const checkout = await creem.createCheckout({
    productId: productIdFor(env, interval) as string,
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
    created_at?: unknown;
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

  if (!db.batch) throw new Error("Atomic billing database batch is required");
  const recordId = `bev_${crypto.randomUUID()}`;
  const known =
    Object.hasOwn(EVENT_STATUS, eventType) ||
    eventType === "subscription.update" ||
    eventType === "checkout.completed";
  const eventCreatedAt = known ? requiredTimestamp(event.created_at) : null;
  const prepared = known
    ? await prepareSubscriptionEvent(
        db,
        env,
        eventType,
        event.object,
        eventCreatedAt as number,
        now,
        recordId,
      )
    : null;
  const marker = db
    .prepare(`INSERT OR IGNORE INTO billing_events
    (id, provider, provider_event_id, event_type, processed_at, provider_subscription_id, provider_created_at, subscription_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      recordId,
      CREEM_PROVIDER,
      providerEventId,
      eventType,
      now,
      prepared?.subscriptionId ?? null,
      eventCreatedAt,
      prepared?.status ?? null,
    );
  const statements = [marker, ...(prepared?.statements ?? [])];
  const results = await db.batch(statements);
  if (
    results.length !== statements.length ||
    results.some(
      (result) => (result as { success?: boolean }).success === false,
    )
  ) {
    throw new Error("Billing transaction failed");
  }
  if (changesOf(results[0]) !== 1) {
    return { duplicate: true as const, eventType };
  }
  if (prepared && results.slice(2).some((result) => changesOf(result) > 0)) {
    try {
      await db.invalidateEvents?.({ userId: prepared.userId });
    } catch {
      console.error(
        JSON.stringify({
          code: "EVENT_INVALIDATION_FAILED",
          userId: prepared.userId,
        }),
      );
    }
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

function timestampOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function requiredTimestamp(value: unknown) {
  const time = timestampOf(value);
  if (time === null || time <= 0 || !Number.isSafeInteger(time)) {
    throw new UnprocessableWebhookError(
      "A valid provider timestamp is required",
    );
  }
  return time;
}

function idOf(value: unknown) {
  return readString(value) || readString(readObject(value)?.id);
}

function dateField(object: Record<string, unknown>, ...names: string[]) {
  const values = names
    .filter((name) => object[name] !== undefined && object[name] !== null)
    .map((name) => requiredTimestamp(object[name]));
  if (new Set(values).size > 1)
    throw new UnprocessableWebhookError("Conflicting subscription dates");
  return values[0] ?? null;
}

function changesOf(result: unknown) {
  return (
    (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0
  );
}

async function prepareSubscriptionEvent(
  db: BillingDatabase,
  env: BillingEnvironment,
  eventType: string,
  objectValue: unknown,
  eventCreatedAt: number,
  now: number,
  recordId: string,
) {
  const object = readObject(objectValue);
  if (!object) throw new UnprocessableWebhookError();
  const checkout = eventType === "checkout.completed";
  const subscription = checkout
    ? (readObject(object.subscription) ?? {})
    : object;
  const subscriptionId = checkout ? idOf(object.subscription) : idOf(object);
  const customerId = customerIdOf(object) || customerIdOf(subscription);
  const productId = idOf(object.product) || idOf(subscription.product);
  if (
    (customerIdOf(subscription) && customerIdOf(subscription) !== customerId) ||
    (idOf(subscription.product) && idOf(subscription.product) !== productId)
  ) {
    throw new UnprocessableWebhookError(
      "Conflicting checkout identity or product",
    );
  }
  if (
    !env.CREEM_PRODUCT_MONTHLY ||
    !env.CREEM_PRODUCT_ANNUAL ||
    env.CREEM_PRODUCT_MONTHLY === env.CREEM_PRODUCT_ANNUAL
  )
    throw new BillingNotConfiguredError();
  const interval =
    productId === env.CREEM_PRODUCT_MONTHLY
      ? "month"
      : productId === env.CREEM_PRODUCT_ANNUAL
        ? "year"
        : null;
  if (!interval)
    throw new UnprocessableWebhookError("Unrecognized subscription product");
  const claimedUsers = [metadataOf(object), metadataOf(subscription)]
    .flatMap((metadata) => [
      readString(metadata.userId),
      readString(metadata.user_id),
    ])
    .filter(Boolean);
  if (new Set(claimedUsers).size > 1)
    throw new UnprocessableWebhookError("Conflicting user metadata");
  const link = await db
    .prepare(`SELECT user_id AS userId, provider_customer_id AS customerId
    FROM billing_subscription_links WHERE provider = ? AND provider_subscription_id = ?`)
    .bind(CREEM_PROVIDER, subscriptionId)
    .first<{ userId: string; customerId: string }>();
  const userId = claimedUsers[0] || link?.userId || "";
  if (!userId || !subscriptionId || !customerId) {
    throw new UnprocessableWebhookError();
  }
  if (link && (link.userId !== userId || link.customerId !== customerId)) {
    throw new UnprocessableWebhookError("Subscription owner mismatch");
  }
  const conflict = await db
    .prepare(`SELECT user_id FROM billing_subscription_links
    WHERE provider = ? AND provider_customer_id = ? AND user_id != ? LIMIT 1`)
    .bind(CREEM_PROVIDER, customerId, userId)
    .first();
  if (conflict) throw new UnprocessableWebhookError("Customer owner mismatch");
  const user = await db
    .prepare("SELECT id FROM user WHERE id = ?")
    .bind(userId)
    .first<{ id: string }>();
  if (!user) throw new UnprocessableWebhookError();
  const linkStatement = db
    .prepare(`INSERT INTO billing_subscription_links
    (provider, provider_subscription_id, provider_customer_id, user_id, created_at)
    SELECT ?, ?, ?, CASE WHEN EXISTS (
      SELECT 1 FROM billing_subscription_links WHERE provider = ? AND provider_customer_id = ? AND user_id != ?
    ) THEN NULL ELSE ? END, ?
    WHERE EXISTS (SELECT 1 FROM billing_events WHERE id = ?)
    ON CONFLICT(provider, provider_subscription_id) DO UPDATE SET user_id = CASE
      WHEN billing_subscription_links.user_id = excluded.user_id
        AND billing_subscription_links.provider_customer_id = excluded.provider_customer_id
      THEN billing_subscription_links.user_id ELSE NULL END`)
    .bind(
      CREEM_PROVIDER,
      subscriptionId,
      customerId,
      CREEM_PROVIDER,
      customerId,
      userId,
      userId,
      now,
      recordId,
    );
  if (checkout)
    return {
      userId,
      subscriptionId,
      status: null,
      statements: [linkStatement],
    };
  const status =
    eventType === "subscription.update"
      ? readString(subscription.status)
      : EVENT_STATUS[eventType];
  if (!status || !STATUSES.has(status))
    throw new UnprocessableWebhookError("Unknown subscription status");
  const reported = readString(subscription.status);
  if (
    eventType !== "subscription.update" &&
    reported &&
    reported !== status &&
    !(eventType === "subscription.paid" && reported === "paid") &&
    !(eventType === "subscription.scheduled_cancel" && reported === "active")
  ) {
    throw new UnprocessableWebhookError(
      "Event and subscription status disagree",
    );
  }
  const current = await db
    .prepare(`SELECT subscription_created_at AS createdAt FROM subscriptions
    WHERE user_id = ? AND provider_subscription_id = ?`)
    .bind(userId, subscriptionId)
    .first<{ createdAt: number }>();
  const subscriptionCreatedAt = requiredTimestamp(
    subscription.created_at ?? current?.createdAt,
  );
  const periodStart = dateField(
    subscription,
    "current_period_start",
    "current_period_start_date",
  );
  const periodEnd = dateField(
    subscription,
    "current_period_end",
    "current_period_end_date",
  );
  const trialEnd =
    dateField(subscription, "trial_end", "trial_end_date") ??
    (status === "trialing" ? periodEnd : null);
  for (const time of [periodStart, periodEnd, trialEnd]) {
    if (time !== null && (!Number.isSafeInteger(time) || time <= 0))
      throw new UnprocessableWebhookError("Invalid subscription period");
  }
  if (periodStart !== null && periodEnd !== null && periodStart >= periodEnd) {
    throw new UnprocessableWebhookError("Invalid subscription period");
  }
  const periodEventAt =
    periodEnd !== null || trialEnd !== null ? eventCreatedAt : 0;
  const paidEventAt =
    ["active", "scheduled_cancel"].includes(status) &&
    periodStart !== null &&
    periodEnd !== null
      ? eventCreatedAt
      : 0;
  const stateStatement = db
    .prepare(
      `INSERT INTO subscriptions (
          id, user_id, provider, provider_customer_id, provider_subscription_id,
          billing_interval, status, current_period_start, current_period_end,
          created_at, updated_at, event_created_at, subscription_created_at,
          provider_product_id, trial_end, grace_period_end, event_priority,
          period_event_at, paid_event_at, paid_period_end, past_due_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM billing_events WHERE id = ?)
        ON CONFLICT(user_id) DO UPDATE SET
          paid_event_at = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.paid_event_at ELSE excluded.paid_event_at END,
          paid_period_end = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.paid_period_end ELSE excluded.paid_period_end END,
          period_event_at = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.period_event_at ELSE excluded.period_event_at END,
          provider_customer_id = excluded.provider_customer_id,
          provider_subscription_id = excluded.provider_subscription_id,
          provider_product_id = excluded.provider_product_id,
          billing_interval = excluded.billing_interval,
          status = excluded.status,
          current_period_start = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.current_period_start ELSE excluded.current_period_start END,
          current_period_end = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.current_period_end ELSE excluded.current_period_end END,
          trial_end = CASE WHEN subscriptions.provider_subscription_id = excluded.provider_subscription_id THEN subscriptions.trial_end ELSE excluded.trial_end END,
          updated_at = excluded.updated_at,
          event_created_at = excluded.event_created_at,
          event_priority = excluded.event_priority,
          subscription_created_at = excluded.subscription_created_at
        WHERE (
          subscriptions.provider_subscription_id = excluded.provider_subscription_id
          AND (excluded.event_created_at > subscriptions.event_created_at
            OR (excluded.event_created_at = subscriptions.event_created_at AND excluded.event_priority > subscriptions.event_priority))
          AND (subscriptions.status NOT IN ('canceled', 'expired') OR excluded.status = subscriptions.status)
        ) OR (
          subscriptions.provider_subscription_id != excluded.provider_subscription_id
          AND excluded.subscription_created_at > subscriptions.subscription_created_at
        )`,
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
      eventCreatedAt,
      subscriptionCreatedAt,
      productId,
      trialEnd,
      STATUS_PRIORITY[status],
      periodEventAt,
      paidEventAt,
      paidEventAt ? periodEnd : null,
      status === "past_due" ? eventCreatedAt : null,
      recordId,
    );
  // Status order and dated access evidence are separate: delayed payment data must not restore a revoked status.
  const evidenceStatement = db
    .prepare(`UPDATE subscriptions SET
    current_period_start = CASE WHEN ? > period_event_at THEN COALESCE(?, current_period_start) ELSE COALESCE(current_period_start, ?) END,
    current_period_end = CASE WHEN ? > period_event_at THEN COALESCE(?, current_period_end) ELSE COALESCE(current_period_end, ?) END,
    trial_end = CASE WHEN ? > period_event_at THEN COALESCE(?, trial_end) ELSE COALESCE(trial_end, ?) END,
    period_event_at = MAX(period_event_at, ?),
    paid_period_end = CASE WHEN ? > paid_event_at THEN ? ELSE paid_period_end END,
    paid_event_at = MAX(paid_event_at, ?)
    WHERE user_id = ? AND provider_subscription_id = ? AND EXISTS (SELECT 1 FROM billing_events WHERE id = ?)`)
    .bind(
      periodEventAt,
      periodStart,
      periodStart,
      periodEventAt,
      periodEnd,
      periodEnd,
      periodEventAt,
      trialEnd,
      trialEnd,
      periodEventAt,
      paidEventAt,
      paidEventAt ? periodEnd : null,
      paidEventAt,
      userId,
      subscriptionId,
      recordId,
    );
  const graceStatement = db
    .prepare(`WITH recovery AS (
    SELECT MIN(e.provider_created_at) AS started FROM billing_events e JOIN subscriptions s
      ON s.provider = e.provider AND s.provider_subscription_id = e.provider_subscription_id
    WHERE s.user_id = ? AND s.provider_subscription_id = ? AND e.subscription_status = 'past_due'
      AND e.provider_created_at >= s.paid_event_at AND e.provider_created_at <= s.event_created_at
  ) UPDATE subscriptions SET
    past_due_at = CASE WHEN status = 'past_due' THEN (SELECT started FROM recovery) ELSE NULL END,
    grace_period_end = CASE WHEN status = 'past_due' AND paid_period_end IS NOT NULL
      THEN MIN((SELECT started FROM recovery), paid_period_end) + ${PAYMENT_GRACE_MS} ELSE NULL END
    WHERE user_id = ? AND provider_subscription_id = ? AND EXISTS (SELECT 1 FROM billing_events WHERE id = ?)`)
    .bind(userId, subscriptionId, userId, subscriptionId, recordId);
  return {
    userId,
    subscriptionId,
    status,
    statements: [
      linkStatement,
      stateStatement,
      evidenceStatement,
      graceStatement,
    ],
  };
}
