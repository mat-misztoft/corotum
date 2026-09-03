import { isSameOrigin, jsonError, readJson } from "./api";
import {
  BillingCustomerMissingError,
  type BillingDatabase,
  type BillingEnvironment,
  BillingNotConfiguredError,
  BillingUnavailableError,
  type CreemClient,
  CreemProviderError,
  createHostedCheckout,
  createHostedPortal,
  HOSTED_ANNUAL_PRICE_CENTS,
  HOSTED_MONTHLY_PRICE_CENTS,
  InvalidBillingIntervalError,
  InvalidWebhookSignatureError,
  processCreemWebhook,
  UnprocessableWebhookError,
} from "./billing";
import { clientIp, protectCloudRequest } from "./cloud-protect";

export type BillingUser = Readonly<{
  id: string;
  email: string;
  name?: string;
}>;

function billingError(error: unknown) {
  if (error instanceof BillingUnavailableError)
    return jsonError(error.message, 404);
  if (error instanceof BillingNotConfiguredError)
    return jsonError(error.message, 503);
  if (error instanceof BillingCustomerMissingError)
    return jsonError(error.message, 404);
  if (error instanceof InvalidBillingIntervalError)
    return jsonError(error.message, 400);
  if (error instanceof InvalidWebhookSignatureError)
    return jsonError(error.message, 401);
  if (error instanceof UnprocessableWebhookError)
    return jsonError(error.message, 400);
  if (error instanceof CreemProviderError) return jsonError(error.message, 503);
  throw error;
}

export async function handleBillingCheckout(
  request: Request,
  db: BillingDatabase,
  env: BillingEnvironment,
  creem: CreemClient,
  user: BillingUser | null,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "mutation",
    identity: user ? `user:${user.id}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  if (!user) return jsonError("Authentication required", 401);
  if (!user.email.trim()) return jsonError("A billing email is required", 400);
  const body = await readJson(request);
  if (!body || typeof body !== "object")
    return jsonError("Invalid request", 400);

  try {
    const checkout = await createHostedCheckout(env, creem, {
      userId: user.id,
      email: user.email,
      name: user.name,
      interval: (body as { interval?: unknown }).interval,
      successUrl: `${new URL(request.url).origin}/dashboard/billing`,
    });
    return Response.json({
      checkoutUrl: checkout.checkoutUrl,
      interval: checkout.interval,
      monthlyPriceCents: HOSTED_MONTHLY_PRICE_CENTS,
      annualPriceCents: HOSTED_ANNUAL_PRICE_CENTS,
    });
  } catch (error) {
    return billingError(error);
  }
}

export async function handleBillingPortal(
  request: Request,
  db: BillingDatabase,
  env: BillingEnvironment,
  creem: CreemClient,
  user: BillingUser | null,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "mutation",
    identity: user ? `user:${user.id}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  if (!user) return jsonError("Authentication required", 401);

  try {
    const portal = await createHostedPortal(db, env, creem, user.id);
    return Response.json({ portalUrl: portal.url });
  } catch (error) {
    return billingError(error);
  }
}

export async function handleCreemWebhook(
  request: Request,
  db: BillingDatabase,
  env: BillingEnvironment,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "normal",
    identity: `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  const payload = await request.text();
  try {
    const result = await processCreemWebhook(
      db,
      env,
      payload,
      request.headers.get("creem-signature"),
    );
    return Response.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    return billingError(error);
  }
}
