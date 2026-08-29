# T067 Security and privacy evidence

Recorded against the product sources and tests in this repository. v0.1 binaries remain unsigned. Signing and notarization are out of scope.

## Paths exercised

| Path | Expected | Result |
| --- | --- | --- |
| Pairing secrets | `device_code` hashed; guessed codes do not create devices | PASS |
| Device tokens | Only `token_hash` persisted; revoke/logout invalidate access and keep device rows | PASS |
| Authorization | Missing token, wrong device, wrong workspace, and cross-origin browser mutations are rejected without writes | PASS |
| Creem webhook | Invalid signatures do not grant hosted entitlement; duplicate event IDs are ignored | PASS |
| Rate limits | Pairing/auth and mutation classes return 429 after budget; no extra pairing rows | PASS |
| CLI 426 | Missing/old `x-toolmirror-cli-version` returns 426 before Cloud mutation | PASS |
| Credential URLs | Git sources, Cloud origin, pending resolution, and Cloud PUT reject embedded userinfo | PASS |
| Log injection | Tokens, URL userinfo, skill content, and Bearer secrets are redacted | PASS |
| Telemetry injection | Extra/private fields (skill names, repos, paths, tokens, device names) are dropped | PASS |
| Malicious release metadata | Path-escaping `version`/`object` cannot download outside `releases/vX.Y.Z/binaries/` or replace a verified executable | PASS |

## Database and log evidence

- `cli_pairings` stores `device_code_hash`, never a plaintext `device_code` column.
- `device_tokens` stores `token_hash`, never a plaintext `token` column.
- Local logs write `[REDACTED]` in place of secrets and skill file contents.
- Anonymous telemetry allowlists technical fields only (D131).

## Defects found and fixed

1. Official installers interpolated `latest.json` `version` into download URLs without a `X.Y.Z` check, so `0.1.0/../../secret` could escape the release prefix. `install.sh` and `install.ps1` now reject invalid versions before any archive download.
2. Cloud PUT desired-state accepted Git sources with embedded credentials even though D056 forbids them. `handlePutWorkspaceState` now rejects those payloads with HTTP 400 and does not create a revision.
3. `SanitizedLogger` wrote caller-supplied event names verbatim, so a newline-bearing event could inject a fake log line. Event names are now restricted to `[A-Za-z0-9._-]{1,64}`; anything else is stored as `invalid.event`.

## Release layout

The security suite writes a pipeline-proof unsigned layout under `dist/r2` so `bun run release:verify` can confirm checksums, `latest.json`, and the UNSIGNED/PIPELINE_PROOF markers. Artifacts are not a final release.
