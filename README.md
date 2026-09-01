# Corotum

Keep your agent skills in sync.

Corotum is an AGPLv3 skill manager that defines one desired state and reconciles AI agent skills across machines. It supports a free Git Sync backend and hosted or self-hosted Corotum Cloud.

v0.1 binaries are unsigned. Official installers are the only supported installation method. There is no daemon and no remote forced sync.

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

## Docs

- [Public documentation](./docs/README.md)
- [CLI](./docs/cli.md)
- [Skills and v2 contracts](./docs/skills.md)
- [Git Sync](./docs/git-sync.md)
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
