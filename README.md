# Corotum

Keep your agent skills in sync.

Corotum is an AGPLv3 skill manager that defines one desired state and reconciles AI agent skills across machines. Cloud Sync is the current workstream (hosted corotum.com or self-hosted Cloud). Git Sync / Free remains a fully documented Git-backed backend with no Corotum account. Neither mode is hidden or removed.

Binaries are unsigned. Official installers are the only supported installation method. Cloud automatic sync is opt-in; Git Sync remains manual. There is no remote forced sync.

## Install

macOS/Linux:

```bash
curl -fsSL https://corotum.com/install.sh | sh
```

Windows:

```powershell
irm https://corotum.com/install.ps1 | iex
```

Update:

```bash
corotum cli-update --check
corotum cli-update
```

## Get started

`corotum` with no command prints a read-only welcome/system screen. `corotum --help` and `corotum --version` have no side effects.

On a TTY, `corotum init` interactively chooses Git Sync versus Corotum Cloud, then which local skills to check and adopt. Explicit providers skip the backend prompt:

```bash
corotum init repository git@github.com:example/corotum-state.git
corotum login
corotum init cloud
```

Zero installed or enabled agents is valid. Global skills live in `~/.agents/skills` independently of agents. Optional `corotum agents` commands scan, enable, or disable local agent exposure later. In Cloud mode the same skill commands as Git Sync (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) mutate Cloud desired state. The dashboard and WebMCP can mutate that state too. After `corotum sync`, the device reports its applied revision.

After Cloud initialization, optionally enable a per-user native background service:

```bash
corotum auto enable
corotum --json auto status
corotum auto disable
```

[Automatic Cloud sync](https://docs.corotum.com/cloud/automatic-sync/) uses the installed standalone binary on macOS arm64/x64, Linux arm64/x64, and Windows x64; no separate Bun or Node runtime is needed. It preserves normal sync conflict checks and reconnects after offline periods.

## Docs

- [Public documentation](https://docs.corotum.com)
- [CLI](https://docs.corotum.com/cli/commands/)
- [Skills and v2 contracts](https://docs.corotum.com/concepts/skills/)
- [Git Sync](https://docs.corotum.com/concepts/git-sync/)
- [Dashboard and WebMCP](https://docs.corotum.com/webmcp/dashboard-and-webmcp/)
- [Migration](https://docs.corotum.com/guides/migration/)
- [Self-hosted Cloud](https://docs.corotum.com/cloud/self-hosting/) — Creem is not required
- [Hosted corotum.com](https://docs.corotum.com/cloud/hosted/)

## Development

Requires [Bun](https://bun.sh/) 1.3 or newer.

```bash
bun install
bun run typecheck
bun run lint
bun run docs:check
bun run docs:build
```

Build a standalone CLI binary:

```bash
bun run build:cli:darwin-arm64
bun run build:cli:darwin-x64
bun run build:cli:linux-arm64
bun run build:cli:linux-x64
bun run build:cli:windows-x64
```

`bun run build:cli` is darwin-arm64. `bun run build:cli:linux` is linux-x64.

Verify (example, macOS arm64):

```bash
./scripts/verify-cli.sh dist/corotum-darwin-arm64
```

Linux x64 is also built and run in [the compile proof workflow](./.github/workflows/cli-compile.yml).

## CLI releases

The CLI version lives in `apps/cli/package.json`, independently of the website,
repository, and docs versions. Bump it only for CLI releases. The binary and R2
release scripts use that version.

After committing and pushing the CLI changes, publish an annotated matching tag:

```bash
git tag -a cli-v0.7.3 -m "CLI 0.7.3"
git push origin cli-v0.7.3
```

The `Final release` workflow tests, builds all five targets, and uploads to R2.
It rejects tags that disagree with the CLI package version. Website commits and
legacy `v*` tags do not publish the CLI. A manual workflow run publishes the CLI
version from the selected ref.

## License

[GNU Affero General Public License v3.0 or later](./LICENSE).
