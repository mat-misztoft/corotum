# Hosted toolmirror.com

This page is only for the hosted ToolMirror Cloud service at `https://toolmirror.com`. Self-hosted deployments must not follow the Creem steps here. See [self-hosting.md](./self-hosting.md) instead.

Hosted Cloud Sync, dashboard Cloud mutations, and paid WebMCP Cloud operations require an active hosted Cloud entitlement. Login and device pairing are allowed without a subscription.

## Price

One product: ToolMirror Cloud.

| Interval | Price |
| --- | --- |
| month | $5.99 |
| year | $59.90 |

## Creem subscription

Hosted billing uses Creem. Verified Creem webhook state is authoritative. Duplicate provider event ids are ignored.

Entitled webhook statuses: `subscription.active`, `subscription.trialing`, `subscription.paid`. Access is revoked on `subscription.paused`, `subscription.expired`, and `subscription.canceled`.

## Checkout and portal

On hosted toolmirror.com, open `/dashboard/billing`:

1. Start monthly checkout ($5.99) or annual checkout ($59.90).
2. Complete Creem checkout. On success you return to the hosted origin.
3. After a verified webhook, Cloud Sync and paid Cloud operations are entitled.
4. Manage the subscription through the billing portal (Creem customer portal) when a subscription exists.

The dashboard only opens the authenticated customer's portal.

## Hosted entitlement

Without an entitled subscription, pairing can still succeed. Cloud init and Cloud desired-state operations then fail with a hosted subscription required error (HTTP `402` on API/WebMCP). Self-hosted Cloud does not use this gate.

## Hosted operator environment

These variables are for the toolmirror.com deployment only:

| Name | Purpose |
| --- | --- |
| `TOOLMIRROR_HOSTED` | `true` or `1` |
| `CREEM_API_KEY` | Creem API key |
| `CREEM_WEBHOOK_SECRET` | Webhook HMAC secret |
| `CREEM_PRODUCT_MONTHLY` | Monthly product id |
| `CREEM_PRODUCT_ANNUAL` | Annual product id |
| `CREEM_API_URL` | Optional. Default `https://api.creem.io` |

Webhook endpoint: `POST https://toolmirror.com/api/v1/webhooks/creem`.

Hosted auth still requires the same Better Auth secret, `BETTER_AUTH_URL`, GitHub OAuth, and Google OAuth as self-hosting. Creem is additional hosted billing, not a replacement for OAuth.

## CLI against hosted Cloud

```bash
curl -fsSL https://toolmirror.com/install.sh | sh
toolmirror login
toolmirror init cloud --source owner/skills
```

Default origin is `https://toolmirror.com`. After checkout and a verified webhook, Cloud init can write desired state. Device pairing without a subscription does not grant Cloud Sync.
