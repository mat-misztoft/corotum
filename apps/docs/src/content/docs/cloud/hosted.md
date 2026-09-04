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

Hosted billing uses Creem. Verified Creem webhook state is authoritative. Duplicate provider event ids are ignored.

Entitled webhook statuses: `subscription.active`, `subscription.trialing`, `subscription.paid`. Access is revoked on `subscription.paused`, `subscription.expired`, and `subscription.canceled`.

## Checkout and portal

On hosted corotum.com, open `/dashboard/billing`:

1. Start monthly checkout ($5.99) or annual checkout ($59.90).
2. Complete Creem checkout. On success you return to the hosted origin.
3. After a verified webhook, Cloud Sync and paid Cloud operations are entitled.
4. Manage the subscription through the billing portal (Creem customer portal) when a subscription exists.

The dashboard only opens the authenticated customer's portal.

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

`bun run release:deploy` is a separate Worker deploy: `CLOUDFLARE_API_TOKEN` is required, `CLOUDFLARE_ACCOUNT_ID` is optional. That script is not wired into `release.yml`.

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

After entitlement, `corotum init cloud` adopts selected skills from `~/.agents/skills` using the same provenance rules as Git init. Zero agents is valid. The same skill commands as Git Sync (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) mutate Cloud desired state. Dashboard and WebMCP can mutate that state too. Devices apply exact locked revisions with `corotum sync`, then report the applied revision. The dashboard does not show `SYNCED` until that report exists. Source-backed skills are fetched with system Git on that device. Artifact-backed skills download from authenticated R2. Retention keeps the current artifact plus one previous artifact per skill. Sync never uses upstream `HEAD`. There is no daemon and no remote forced sync. Details: [skills.md](/concepts/skills/).

## CLI against hosted Cloud

```bash
curl -fsSL https://corotum.com/install.sh | sh
corotum login
corotum init cloud
corotum add owner/skills --skill review --ref main
corotum sync
```

Default origin is `https://corotum.com`. After checkout and a verified webhook, Cloud init and Cloud skill mutations can write desired state. Device pairing and authentication without a subscription do not grant Cloud Sync. Hosted `402` after pairing stays entitlement-gated and does not mutate local files.
