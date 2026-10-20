---
title: Hosted corotum.com
---

This page is only for the hosted Corotum Cloud service at `https://corotum.com`. Self-hosted deployments must not follow the Creem steps here. See [self-hosting.md](/cloud/self-hosting/) instead.

Hosted Cloud Sync, CLI Cloud skill mutations, dashboard Cloud mutations, and paid WebMCP Cloud operations require an active hosted Cloud entitlement. Login and device pairing are allowed without a subscription. The dashboard is a full product surface. Self-hosted Cloud does not use this Creem gate.

## Price

One product: Corotum Cloud.

| Interval | Price |
| --- | --- |
| month | $5.99 |
| year | $59.90 |

## Creem subscription

Hosted billing uses Creem. Verified Creem webhook state is authoritative. Configure all eleven events below on the same webhook endpoint:

| Event | Access policy |
| --- | --- |
| `subscription.paid` | Activate or renew through the supplied period end |
| `subscription.active` | Activate a securely identified subscription through its period end |
| `subscription.trialing` | Access until trial end (or the supplied trial period end) |
| `subscription.scheduled_cancel` | Keep access only until the current period ends |
| `subscription.past_due` | Keep previously paid access through a fixed three-day payment-recovery grace period |
| `subscription.unpaid` | Suspend access |
| `subscription.paused` | Suspend access; a newer active/paid event can restore it |
| `subscription.expired` | Revoke access |
| `subscription.canceled` | Revoke access |
| `subscription.update` | Update product, interval, period and status; apply the same access rules |
| `checkout.completed` | Bind the customer and subscription to the account; never grant access by itself |

The grace deadline is three days after the earlier of the first `past_due` event and the previously paid period end. Repeated failures do not extend it; an initial failed payment does not grant grace access. Recovery clears the deadline so the next billing cycle can have its own recovery period. All access checks enforce start/end dates even if a final webhook is delayed. Missing verified product or required access dates denies paid access. WebSocket authorization is capped by the same deadline and rechecked before revision broadcasts.

Only the configured monthly and annual product IDs can update hosted subscriptions. Product determines billing interval; metadata cannot override it. Conflicting account/customer/subscription identities are rejected. Events without user metadata require an existing exact subscription binding, not an email or customer-only guess. An early unbound event fails so Creem can retry after a checkout or metadata-bearing subscription event establishes its binding.

Event recording, identity binding and subscription writes use one atomic D1 batch. Duplicate deliveries cannot mutate state twice; failed writes roll back so retries can succeed. Provider event timestamps and subscription creation dates prevent old deliveries from replacing newer state. At equal event times, revocation/suspension takes priority over grants. Canceled and expired subscriptions cannot be reactivated; a new subscription must have a newer creation date. Unknown future event types are acknowledged and recorded without changing access.

## Checkout and portal

On hosted corotum.com, open `/dashboard/billing`:

1. Start monthly checkout ($5.99) or annual checkout ($59.90).
2. Complete Creem checkout. On success you return to the hosted origin.
3. After a verified webhook, Cloud Sync and paid Cloud operations are entitled.
4. Manage the subscription through the billing portal (Creem customer portal) when a subscription exists.

The dashboard only opens the authenticated customer's portal.

An existing non-terminal subscription blocks another checkout and account deletion. Manage or cancel it in Billing first; account deletion becomes available after Corotum receives the cancellation webhook. Hosted paid access starts on 22 October 2026 at 00:00 UTC.

Before deploying the billing changes, apply the production D1 migrations from `apps/web`: `bunx wrangler d1 migrations apply corotum --remote`. Migration `0015_billing_event_order.sql` adds webhook ordering timestamps. Migration `0016_billing_lifecycle.sql` preserves ownership bindings and adds product/trial/grace fields. Legacy rows have no verified product and therefore do not grant paid access until a new, verified current Creem event supplies product and date information. Before launch, reconcile any existing paid accounts against their current Creem subscription state. Resending an already processed historical event does not bypass deduplication or prove current entitlement. Existing rows use their stored receipt dates until a newer event supplies provider timestamps. Confirm checkout, webhook activation, renewal, cancellation and CLI sync before the paid launch. Migrations and deployment are separate operator actions; the CLI release workflow does not run them.

## Hosted entitlement

Without an entitled subscription, pairing can still succeed. Cloud init and Cloud desired-state operations then fail with a hosted subscription required error (HTTP `402` on API/WebMCP). Self-hosted Cloud does not use this gate.

## Hosted operator environment

These variables are for the corotum.com deployment only:

| Name | Purpose |
| --- | --- |
| `COROTUM_HOSTED` | `true` or `1` |
| `CREEM_API_KEY` | Creem API key |
| `CREEM_WEBHOOK_SECRET` | Webhook HMAC secret |
| `CREEM_PRODUCT_MONTHLY` | Monthly product id |
| `CREEM_PRODUCT_ANNUAL` | Annual product id |
| `CREEM_API_URL` | Optional. Default `https://api.creem.io` |
| `UMAMI_HOST` | Optional. Self-hosted Umami origin, no trailing slash |
| `UMAMI_WEBSITE_ID` | Optional. Umami website id |

Webhook endpoint: `POST https://corotum.com/api/v1/webhooks/creem`.

Website analytics is cookieless Umami, separate from CLI telemetry. Set both `UMAMI_HOST` and `UMAMI_WEBSITE_ID` to load `script.js` and `recorder.js` in the document head. Omit both to leave it off.

Hosted auth still requires the same Better Auth secret, `BETTER_AUTH_URL`, GitHub OAuth, and Google OAuth as self-hosting. Creem is additional hosted billing, not a replacement for authentication.

Worker `vars` and `wrangler secret put` live on the Cloudflare Worker. They are not GitHub Actions secrets.

## Official CLI release (GitHub Actions)

`.github/workflows/release.yml` rebuilds CLI binaries from the tag and uploads them to the public releases R2 bucket. It does not deploy the Worker and does not inject auth, Creem, email, or Umami variables.

Repository secrets for `bun run release:upload`:

| Name | Purpose |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account id for the releases S3 API |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET` | Releases bucket name |

The workflow sets `RELEASE_REQUIRE_UPLOAD=1`. `.github/workflows/cli-compile.yml` has no secrets.

`bun run release:deploy` is a separate Worker deployment: it deploys `apps/events` first, then `apps/web`. `CLOUDFLARE_API_TOKEN` is required, `CLOUDFLARE_ACCOUNT_ID` is optional. That script is not wired into `release.yml`. The main app's `EVENTS` service binding targets `corotum-events`; the private events Worker needs no public hostname. See [self-hosting deployment](/cloud/self-hosting/#deploy) for the binding and deployment commands.

For separate Cloudflare Workers Builds, connect `corotum-events` to the same repository with path `apps/events`, no build command, and deploy command `bunx wrangler deploy`. Deploy it successfully once before deploying `corotum-production`. Production can keep its own deploy command `cd apps/web && bunx wrangler deploy` from the repository root. Docs, events, and production remain separate Workers.

## Email magic-link authentication

Users can sign in at `/sign-in` with GitHub, Google, or an email magic link. A magic link creates an account for a new address or signs into the existing account for that address; it does not reveal whether the address already has an account. Links are single-use, expire, and return only to safe same-origin paths. Authentication and device pairing work before a subscription exists. The hosted entitlement gate still applies separately to paid Cloud Sync and Cloud mutations.

Corotum's hosted Worker sends transactional sign-in email through the Cloudflare Email Service `send_email` binding. It does **not** need a separate email API key.

### Hosted email configuration contract

Before production magic-link testing, an operator must:

1. Confirm Cloudflare Email Sending is enabled for the production account. Cloudflare currently describes outbound Email Sending as beta and as subject to applicable account/plan availability; check its current documentation rather than treating availability, pricing, or limits as permanent guarantees.
2. Onboard `corotum.com` as a sending domain in Cloudflare Email Service and publish every required sending-domain DNS/authentication record (including the records Cloudflare supplies for sender authentication).
3. Configure the Corotum authentication sender as `auth@corotum.com`; it must be an allowed sender address on that onboarded domain.
4. Keep the Worker `send_email` binding named `EMAIL` with `auth@corotum.com` in its allowed sender addresses. `apps/web/wrangler.jsonc` is the hosted binding configuration.
5. Deploy with the Worker binding, then request a link and confirm that it is delivered and can establish a session.

For local Worker development, the email-related `.dev.vars` entry is exactly:

```dotenv
AUTH_EMAIL_FROM=auth@corotum.com
```

`EMAIL` is a Cloudflare Worker `send_email` binding, not a `.dev.vars` secret or variable. Hosted Worker delivery uses that binding and needs no email API key.

## Cloud Sync behavior

After entitlement, `corotum init cloud` adopts selected skills from `~/.agents/skills` using the same provenance rules as Git init. Zero agents is valid. The same skill commands as Git Sync (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) mutate Cloud desired state. Dashboard and WebMCP can mutate that state too. Devices apply exact locked revisions with `corotum sync`, then report the applied revision. The dashboard does not show `SYNCED` until that report exists. Source-backed skills are fetched with system Git on that device. Artifact-backed skills download from authenticated R2. Retention keeps the current artifact plus one previous artifact per skill. Sync never uses upstream `HEAD`. [Automatic Cloud sync](/cloud/automatic-sync/) is opt-in; there is no remote forced sync. Details: [skills.md](/concepts/skills/).

## CLI against hosted Cloud

```bash
curl -fsSL https://corotum.com/install.sh | sh
corotum login
corotum init cloud
corotum add owner/skills --skill review --ref main
corotum sync
```

Default origin is `https://corotum.com`. After checkout and a verified webhook, Cloud init and Cloud skill mutations can write desired state. Device pairing and authentication without a subscription do not grant Cloud Sync. Hosted `402` after pairing stays entitlement-gated and does not mutate local files.
