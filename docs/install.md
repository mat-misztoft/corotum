# Install and cli-update

Official installers are the only supported installation method. Release artifacts are public, but manual binary download is not an officially supported installation path. v0.1 binaries are unsigned. Installers and `cli-update` verify SHA-256 before replacing a binary.

GitHub Actions rebuilds every release target from the tagged source, writes checksums and `releases/latest.json`, and publishes only after tests, installer smoke, and workerd endpoint checks pass. Pipeline-proof binaries from earlier CI are not reused.

There is no daemon. Corotum does not install a background service and does not remotely force devices to sync.

## macOS and Linux

```bash
curl -fsSL https://corotum.com/install.sh | sh
```

Default location: `~/.local/bin/corotum`. The installer is per-user and does not require sudo. It appends that directory to `PATH` in the user shell startup files when it is not already present.

Supported targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

## Windows

```powershell
irm https://corotum.com/install.ps1 | iex
```

Default location: `%LOCALAPPDATA%\ToolMirror\bin\corotum.exe`. The installer is per-user and does not require Administrator. It adds that directory to the user `Path` when it is not already present.

Windows arm64 is not supported in v0.1.

## What the installer does

1. Reads `https://releases.corotum.com/releases/latest.json`.
2. Downloads `checksums.txt` and the matching `corotum-<os>-<arch>.tar.gz`.
3. Verifies the archive SHA-256.
4. Runs `--version` on the staged binary.
5. Replaces the previous binary only after those checks succeed.
6. Prints that v0.1 binaries are unsigned.

Installer overrides (optional):

| Variable | Purpose |
| --- | --- |
| `TOOLMIRROR_RELEASE_BASE` | Alternate release origin. Default `https://releases.corotum.com` |
| `TOOLMIRROR_BIN_DIR` | Unix install directory. Default `~/.local/bin` |
| `TOOLMIRROR_OS` / `TOOLMIRROR_ARCH` | Test overrides. Do not use these to install an unsupported target |

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

`TOOLMIRROR_RELEASE_BASE` selects the release origin for `cli-update` as well.

## Verify

```bash
corotum --version
corotum --help
```
