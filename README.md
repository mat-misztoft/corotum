# ToolMirror

Keep your agent skills in sync.

ToolMirror is an AGPLv3 skill manager that defines one desired state and reconciles AI agent skills across machines. It supports a free Git Sync backend and hosted or self-hosted ToolMirror Cloud.

> ToolMirror is under active v0.1 development. Installation and self-hosting instructions will be published with the first release.

## Development

Requires [Bun](https://bun.sh/) 1.3 or newer.

```bash
bun install
bun run typecheck
bun run lint
```

## Compiled CLI spike

Build and verify the macOS arm64 standalone binary:

```bash
bun run build:cli
./scripts/verify-cli.sh dist/toolmirror-darwin-arm64
```

The verification runs the binary with a minimal `PATH` that does not contain
Bun. Linux x64 is built and run in [the compile proof workflow](./.github/workflows/cli-compile.yml).

## License

[GNU Affero General Public License v3.0 or later](./LICENSE).
