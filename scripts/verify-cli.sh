#!/usr/bin/env sh
set -eu

binary=${1:?usage: verify-cli.sh path-to-corotum}
expected='corotum 0.5.0'
actual=$(env -i PATH=/usr/bin:/bin "$binary" --version)

if [ "$actual" != "$expected" ]; then
  printf 'Expected "%s", got "%s"\n' "$expected" "$actual" >&2
  exit 1
fi
