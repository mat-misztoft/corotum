# Corotum

Keep your agent skills in sync.

Corotum is an AGPLv3 skill manager that defines one desired state and reconciles AI agent skills across machines. Cloud Sync is the current workstream (hosted corotum.com or self-hosted Cloud). Git Sync / Free remains a fully documented Git-backed backend with no Corotum account. Neither mode is hidden or removed.

v0.5 binaries are unsigned. Official installers are the only supported installation method. There is no daemon and no remote forced sync.

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

Zero installed or enabled agents is valid. Global skills live in `~/.agents/skills` independently of agents. Optional `corotum agents` commands scan, enable, or disable local agent exposure later. In Cloud mode the same skill commands as Git Sync (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) mutate Cloud desired state. The dashboard and WebMCP can mutate that state too. After `corotum sync`, the device reports its applied revision; there is no daemon and no remote forced sync.

## Docs

- [Public documentation](./docs/README.md)
- [CLI](./docs/cli.md)
- [Skills and v2 contracts](./docs/skills.md)
- [Git Sync](./docs/git-sync.md)
- [Dashboard and WebMCP](./docs/dashboard-and-webmcp.md)
- [Migration](./docs/migration.md)
- [Self-hosted Cloud](./docs/self-hosting.md) — Creem is not required
- [Hosted corotum.com](./docs/hosted-cloud.md)

## Development

Requires [Bun](https://bun.sh/) 1.3 or newer.

```bash
bun install
bun run typecheck
bun run lint
bun run docs:check
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

## License

[GNU Affero General Public License v3.0 or later](./LICENSE).
