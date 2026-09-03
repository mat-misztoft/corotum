---
title: Self-hosted Corotum Cloud
---

Self-hosted Corotum Cloud is free under AGPLv3. Hosted Corotum billing is not required for self-hosted Cloud. Creem is not required. Do not configure Creem. Auth and OAuth are configured independently from hosted billing.

There is no daemon and no remote forced sync. Devices pair in a browser and apply or report state only when the CLI runs on that device.

## What you deploy

The `apps/web` Cloudflare Worker (vinext / Next.js on workerd) plus one D1 database. The same process serves the landing page, dashboard, WebMCP, and `/api/v1/` Cloud API.

Leave `COROTUM_HOSTED` unset or set it to `false`. Only `true` or `1` turns on hosted corotum.com billing. Self-hosted Cloud paths do not check Creem entitlement.

## Prerequisites

- A Cloudflare account and Wrangler authenticated for that account
- [Bun](https://bun.sh/) 1.3 or newer
- A GitHub OAuth App
- A Google OAuth App
- Public HTTPS origin for the Worker
- An independently configured transactional email service/binding for magic-link delivery

Creem, a Creem account, and hosted corotum.com subscription products are not prerequisites.

## AGPL obligations

This software is licensed under [GNU AGPLv3](https://github.com/mat_misztoft/corotum/blob/main/LICENSE). If you run a modified version as a network service, you must offer the corresponding source to users who interact with it over the network. Keep the license text, copyright notices, and a way to obtain the source you actually deploy.

## Create D1 and bindings

From `apps/web`:

```bash
npx wrangler d1 create corotum
```

Put the returned `database_id` in `apps/web/wrangler.jsonc` under `d1_databases` for binding `DB`, database name `corotum`, `migrations_dir` `migrations`. The repository ships with `database_id` `local-toolmirror-d1` for local use; production must use the created id.

Apply migrations:

```bash
npx wrangler d1 migrations apply corotum --remote
```

Local development:

```bash
bun run db:migrate
```

`wrangler.jsonc` already binds:

| Binding | Name | Purpose |
| --- | --- | --- |
| `DB` | D1 `corotum` | Auth, workspaces, revisions, devices, reports, artifact metadata |
| `ARTIFACTS` | R2 `corotum-artifacts` | Artifact-backed skill archives only |
| `ASSETS` | `dist/client` | Built web assets |
| `COROTUM_TELEMETRY` | Analytics Engine dataset `corotum_telemetry` | Optional anonymous CLI telemetry ingest |

Create the R2 bucket named `corotum-artifacts` (or change `bucket_name` to a bucket you own) before serving artifact-backed skills. D1 stores no archive bytes. Retention keeps the current artifact plus one previous artifact per skill; GC deletes an object only when it is absent from both references. See [skills.md](/concepts/skills/).

You do not need a Creem webhook route configuration for self-hosting. Hosted billing routes return that billing is unavailable when the deployment is not hosted.

## Auth and OAuth

Production (anything other than `COROTUM_ENVIRONMENT=development`) requires:

- `BETTER_AUTH_SECRET` at least 32 characters
- `BETTER_AUTH_URL` equal to the public origin, for example `https://cloud.example.com`
- Both GitHub and Google OAuth client id and secret

Create the OAuth apps with:

| Field | Value |
| --- | --- |
| Homepage | `https://cloud.example.com` |
| GitHub callback | `https://cloud.example.com/api/auth/callback/github` |
| Google callback | `https://cloud.example.com/api/auth/callback/google` |

Replace the origin with your `BETTER_AUTH_URL`. Partial OAuth (id without secret, or only one provider) is rejected.

OAuth and email magic-link sign-in are independent of Creem and of hosted corotum.com billing.

## Environment variables

Required for a production self-host:

| Name | How to set | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `npx wrangler secret put BETTER_AUTH_SECRET` | ≥ 32 characters |
| `GITHUB_CLIENT_SECRET` | `npx wrangler secret put GITHUB_CLIENT_SECRET` | |
| `GOOGLE_CLIENT_SECRET` | `npx wrangler secret put GOOGLE_CLIENT_SECRET` | |
| `BETTER_AUTH_URL` | `vars` in `wrangler.jsonc` | Public origin, no trailing path |
| `GITHUB_CLIENT_ID` | `vars` | |
| `GOOGLE_CLIENT_ID` | `vars` | |
| `COROTUM_ENVIRONMENT` | `vars` | `production` |
| `COROTUM_HOSTED` | `vars` | `false` or omit |
| `AUTH_EMAIL_FROM` | `.dev.vars` locally; Worker environment in production | Sender address from your own sending domain |

Example `vars` (do not put secrets here):

```jsonc
"vars": {
  "BETTER_AUTH_URL": "https://cloud.example.com",
  "GITHUB_CLIENT_ID": "your-github-client-id",
  "GOOGLE_CLIENT_ID": "your-google-client-id",
  "COROTUM_ENVIRONMENT": "production",
  "COROTUM_HOSTED": "false"
}
```

Do not set hosted billing variables. Hosted Corotum billing is not required for self-hosted Cloud.

## Email magic links

The `/sign-in` page supports GitHub, Google, and passwordless email links. Email requests always show the same confirmation for new and existing addresses, so the flow does not disclose account existence. Links are hashed at rest, expire, can be used once, and reject unsafe redirects.

A self-hosted deployment must provide its **own** email-delivery configuration. It must not use Corotum-owned Cloudflare Email Service resources, sender domains, or hosted credentials, and it does not require hosted entitlement or Creem. The shipped Worker integration expects an `EMAIL` Cloudflare `send_email` binding and an `AUTH_EMAIL_FROM` sender address; configure both in your own Cloudflare account and for your own onboarded sending domain, or replace the application email boundary with your independently operated transport.

For local development, put only the email sender setting in `apps/web/.dev.vars`:

```dotenv
AUTH_EMAIL_FROM=auth@corotum.com
```

Use your own sender address in a real self-host. `EMAIL` is not a `.dev.vars` secret: it is the Worker `send_email` binding declared in `wrangler.jsonc`. That binding path does not require an email API key. Ensure your chosen provider has enabled sending and that its required sender-domain DNS/authentication records are live before testing real delivery.

Authentication and pairing remain available without a subscription. In contrast, the hosted `corotum.com` deployment uses its own Cloudflare Email Service binding and separately gates paid Cloud operations with Creem; self-hosted Cloud stays usable without Creem.

Optional CLI-side variables, used on devices rather than the Worker:

| Name | Purpose |
| --- | --- |
| `COROTUM_CLOUD_ORIGIN` | Cloud origin for `login`, `init cloud`, and `migrate`. Also `corotum config set origin` |
| `COROTUM_RELEASE_BASE` | CLI release origin for installers and `cli-update` |

## Deploy

From the repository root:

```bash
bun install
bun run web:build
```

From `apps/web`:

```bash
npx wrangler d1 migrations apply corotum --remote
npx wrangler deploy
```

Confirm `https://cloud.example.com` serves the site. Unauthenticated users go to `/sign-in` (GitHub, Google, or email magic link) and reach `/dashboard` after a session is created.

## Operational setup

1. Install the official CLI on each device ([install.md](/getting-started/install/)).
2. Sign in at `/sign-in` with GitHub, Google, or an email magic link. A default workspace is created for the user.
3. Pair a device:

```bash
corotum login --origin https://cloud.example.com
```

Or initialize Cloud and adopt selected local skills in one step:

```bash
corotum init cloud --origin https://cloud.example.com
```

`init cloud` opens the pairing browser flow when the device is not already logged in. Hosted entitlement is not required.

4. Open `/dashboard` for skills, devices, target reports, and settings. The dashboard is a full product surface. Self-hosted billing UI states that Cloud functionality is free and has no billing portal.
5. Mutate Cloud desired state with the same CLI skill commands as Git Sync (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) or with [WebMCP](/webmcp/dashboard-and-webmcp/) / the same-origin dashboard mutation API. Then run `corotum sync` on each device; the device reports the applied revision. There is no daemon and no remote forced sync. Zero agents is valid.
6. Revoke a device from `/dashboard/devices`. Revoke invalidates only that device token and keeps remote machine data.
7. `corotum logout --origin https://cloud.example.com` revokes the local token.

Pairing codes expire after 10 minutes. Cloud may return `426 Upgrade Required` when the CLI is older than `0.1.0`. Git Sync is independent of that check.

## Supported agents and migration

Supported agents are listed in [cli.md](/cli/commands/). v0.5 manages global/user-level skills only.

Git ↔ Cloud migration:

```bash
corotum migrate cloud --strategy replace --origin https://cloud.example.com
corotum migrate git git@github.com:example/corotum-state.git --strategy merge --origin https://cloud.example.com
```

See [migration.md](/guides/migration/). Identity (skill id, source, ref, lock revision, hash, targets) is preserved. The canonical local store is not rewritten by migrate.

## Limitations

- v0.5 binaries are unsigned. Official installers are the supported install path.
- No daemon, watch mode, scheduled updates, or remote forced sync.
- No project-level skills, teams/RBAC, or Windows arm64.
- Production auth requires both GitHub and Google OAuth.
- Self-hosted Cloud does not offer a Creem checkout or billing portal.
- Manual binary download is not an officially supported installation method.
