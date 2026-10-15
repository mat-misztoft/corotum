---
title: Install and cli-update
---

Official installers are the only supported installation method. Release artifacts are public, but manual binary download is not an officially supported installation path. v0.5 binaries are unsigned. Installers and `cli-update` verify SHA-256 before replacing a binary.

GitHub Actions rebuilds every release target from the tagged source, writes checksums and `releases/latest.json`, and publishes only after tests, installer smoke, and workerd endpoint checks pass. Pipeline-proof binaries from earlier CI are not reused. Upload uses repository secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. Worker auth and billing vars are not set in GitHub Actions. See [hosted.md](/cloud/hosted/).

Installation does not enable a background service. After Cloud initialization, opt in with `corotum auto enable`; see [automatic Cloud sync](/cloud/automatic-sync/). Git Sync remains manual; devices cannot be remotely forced to sync.

## macOS and Linux

```bash
curl -fsSL https://corotum.com/install.sh | sh
```

Default location: `~/.local/bin/corotum`. The installer is per-user and does not require sudo. It automatically configures `PATH` for Bash, Zsh (including `ZDOTDIR`), and POSIX login shells without duplicating its entries.

Follow the instructions printed by the installer. After successful PATH setup, open a new terminal and run `corotum init`. The installer cannot change the parent terminal's environment when run through `curl … | sh`; it also prints a quoted full-path command to start initialization immediately.

If a startup file cannot be written or the shell is unsupported (such as Fish), installation still succeeds. The installer warns you, identifies the failed file or unsupported shell, and prints recovery instructions. For supported shells it also prints the exact PATH command for the current terminal. Initialization is not run automatically.

Supported targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

## Windows

```powershell
irm https://corotum.com/install.ps1 | iex
```

Default location: `%LOCALAPPDATA%\ToolMirror\bin\corotum.exe`. The installer is per-user and does not require Administrator. It adds that directory to the user `Path` when it is not already present.

The PowerShell installer also updates `Path` in the current terminal, so you can run `corotum init` immediately. If saving the persistent user `Path` fails, it warns you and prints instructions for future terminals plus a quoted full-path command. The installed binary remains usable.

Windows arm64 is not supported in v0.5.

## What the installer does

1. Reads `https://releases.corotum.com/releases/latest.json`.
2. Downloads `checksums.txt` and the matching `corotum-<os>-<arch>.tar.gz`.
3. Verifies the archive SHA-256.
4. Runs `--version` on the staged binary.
5. Replaces the previous binary only after those checks succeed.
6. Configures the shell/user PATH and reports any configuration failures without treating a verified, installed binary as a failed installation.
7. Prints next steps and an immediate full-path initialization command on Unix; PowerShell updates the current terminal directly. Prints that v0.5 binaries are unsigned.

Installer overrides (optional):

| Variable | Purpose |
| --- | --- |
| `COROTUM_RELEASE_BASE` | Alternate release origin. Default `https://releases.corotum.com` |
| `COROTUM_BIN_DIR` | Unix install directory. Default `~/.local/bin` |
| `COROTUM_OS` / `COROTUM_ARCH` | Test overrides. Do not use these to install an unsupported target |

## Update the CLI

```bash
corotum cli-update --check
corotum cli-update
```

`cli-update --check` reports `UP_TO_DATE` or `AVAILABLE` without modifying the executable.

`corotum cli-update` downloads `latest.json`, verifies SHA-256, and then:

- macOS/Linux: replaces the current executable after the checksum matches.
- Windows: stages a pending update and applies it on a later start. If apply fails, the previous working executable is kept and the error is reported.

Another mutating Corotum process blocks replacement. `--check` does not replace the binary.

`COROTUM_RELEASE_BASE` selects the release origin for `cli-update` as well.

## Verify

```bash
corotum --version
corotum --help
```
