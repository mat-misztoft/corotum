#!/usr/bin/env sh
set -eu

target=${1:?usage: build-cli.sh bun-darwin-arm64|bun-darwin-x64|bun-linux-arm64|bun-linux-x64|bun-windows-x64}

case "$target" in
  bun-darwin-arm64 | bun-darwin-x64 | bun-linux-arm64 | bun-linux-x64 | bun-windows-x64) ;;
  *)
    printf 'Unsupported CLI target: %s\n' "$target" >&2
    exit 1
    ;;
esac

id=${target#bun-}
output="dist/corotum-${id}"
if [ "$id" = windows-x64 ]; then
  output="${output}.exe"
fi
rm -rf dist
mkdir -p dist

if ! bun build apps/cli/src/index.ts --compile --target="$target" --outfile="$output"; then
  rm -f "$output"
  exit 1
fi
