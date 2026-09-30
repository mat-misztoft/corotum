#!/usr/bin/env sh
set -eu

binary=${1:?usage: verify-cli.sh path-to-corotum}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$root/apps/cli/package.json")
expected="corotum $version"
actual=$(env -i PATH=/usr/bin:/bin "$binary" --version)

if [ "$actual" != "$expected" ]; then
  printf 'Expected "%s", got "%s"\n' "$expected" "$actual" >&2
  exit 1
fi
