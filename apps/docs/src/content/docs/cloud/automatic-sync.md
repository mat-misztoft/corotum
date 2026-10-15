---
title: Automatic Cloud sync
---

Automatic sync is an **opt-in, per-device Cloud feature** for hosted and self-hosted workspaces. Installation and login do not enable it. Git Sync remains manual. Cloud sends revision hints, not remote commands: the local worker decides when to reconcile through the same safe sync path as `corotum sync`.

## Enable, inspect, and disable

Initialize Cloud first, then enable the service as your normal user:

```bash
corotum login
corotum init cloud
corotum auto enable
corotum auto status
corotum --json auto status
corotum auto disable
```

For self-hosting, first persist the origin with `corotum config set origin https://cloud.example.com`, then use `corotum login` and `corotum init cloud`. `auto enable` also persists an origin selected through `COROTUM_CLOUD_ORIGIN`, since a native service need not inherit login-shell variables. Hosted entitlement requirements still apply; automatic sync does not bypass them.

`enable` installs and starts the per-user service and enables startup at login. `disable` stops and removes it without deleting skills or changing shared desired state. Use these commands rather than editing `autoSync` in configuration. `corotum auto run` is the long-running **internal service entry point**, not a one-shot sync command. For command help:

```bash
corotum auto --help
corotum auto enable --help
corotum auto disable --help
corotum auto status --help
corotum auto run --help
```

## Platforms and prerequisites

| Official compiled target | Native per-user integration |
| --- | --- |
| macOS arm64 and x64 | launchd LaunchAgent `com.corotum.auto` |
| Linux arm64 and x64 | systemd user unit `corotum-auto.service` |
| Windows x64 | Task Scheduler task `Corotum Auto <user SID>` |

The service invokes the installed standalone `corotum` executable in place. No separate Node.js or Bun runtime is required. Linux needs an available systemd user session; this is not a root system service. Windows uses the signed-in user's interactive logon with limited privileges. Windows arm64 is not a supported compiled target. These are supported integration targets, not a claim that each native OS service has been exercised on real hardware.

Keep the installed executable at its registered path. If you move it, disable and re-enable automatic sync. Source-backed skills still require system Git and working non-interactive repository access; the service cannot open a credential prompt.

## Revisions, offline recovery, and safety

The worker performs an initial reconciliation, then listens for workspace revision notifications over an authenticated WebSocket. Notifications are hints, not a durable queue and not skill contents. On reconnect it checks revision metadata so missed or duplicate hints do not determine correctness. It reconnects with jittered exponential backoff capped at five minutes. An approximately hourly fallback rotates the connection (slightly before its one-hour expiry) or checks metadata while disconnected.

Revision hints use a two-second trailing-edge debounce before reconciliation. Runs are serial and share the mutation lock with foreground commands. Automatic sync uses exact locked revisions, never upstream `HEAD`. It does not force through unmanaged collisions or managed local drift, prompt for artifact adoption, or grant artifact consent. Partial or failed runs remain retryable rather than claiming the desired revision was fully applied. Offline failures retry; they do not turn stale hints into authoritative workspace state.

When a conflict persists, inspect it explicitly:

```bash
corotum auto disable
corotum status
corotum diff
corotum sync
corotum auto enable
```

Review local edits and resolve the reported conflict before re-enabling. Do not delete skills merely to silence a status error.

## Status and diagnostics

`corotum auto status` shows whether automatic sync is enabled, whether the native service is running, the workspace, connection, last successful sync, applied revision, and last error code. `corotum --json auto status` also exposes native service detail, last check, observed revision, outcome, and retry count. A running service is not proof of a successful sync; inspect both native and operational state.

The local state directory contains `auto-status.json`. It is a bounded, overwritten metadata snapshot, not an append-only log. It stores no tokens, skill contents, repository URLs, or raw remote errors. Unix status files use restrictive permissions. Service stdout/stderr are discarded on macOS/Linux; there is no accumulating automatic-sync content log. For actionable sync errors, run foreground `corotum sync`. Native service details are also available through launchd, `systemctl --user status corotum-auto.service`, or Task Scheduler as appropriate.

| Platform | Status file |
| --- | --- |
| macOS | `~/Library/Application Support/Corotum/state/auto-status.json` |
| Linux | `$XDG_STATE_HOME/corotum/auto-status.json` (default `~/.local/state/corotum/auto-status.json`) |
| Windows | `%LOCALAPPDATA%\Corotum\state\auto-status.json` |

## Authentication and security

The worker uses the existing device token in request headers, not a query string. HTTPS is required except for loopback development. WebSocket sessions have a bounded one-hour lifetime and must reconnect through the authenticated main app. Every broadcast rechecks entitlement and active token membership; revoked tokens are excluded even if an explicit disconnect notification failed. Reconnect and metadata requests also recheck authorization. Local configuration and credentials are watched for changes. Disable and CLI upgrades ask the worker to drain ongoing work before stopping the native service. After an authentication error, check pairing and entitlement; authorization retries back off to hourly checks rather than restarting continuously.

Events carry revision metadata only. They do not carry skill archives, credentials, or executable instructions. The server bounds event size and connections per device/workspace. Dashboard `SYNCED` still requires a verified device report; delivery of a notification alone never marks a device synced.

Self-hosted operators must deploy the private events Worker and configure its service binding before the main app; see [self-hosting](/cloud/self-hosting/).
