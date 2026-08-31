#!/bin/sh
# Official Corotum installer.
# This is the only officially supported installation method.
# Manual binary download is not an officially supported installation method.
# v0.1 binaries are unsigned.

set -eu

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

print_banner() {
  printf '%s\n' "Official Corotum installer"
  printf '%s\n' "This is the only officially supported installation method."
  printf '%s\n' "Manual binary download is not an officially supported installation method."
  printf '%s\n' "v0.1 binaries are unsigned."
}

json_string() {
  file=$1
  key=$2
  awk -v key="$key" '
    $0 ~ "\"" key "\"" {
      if (match($0, /:[[:space:]]*"[^"]*"/)) {
        val = substr($0, RSTART, RLENGTH)
        sub(/^:[[:space:]]*"/, "", val)
        sub(/"$/, "", val)
        print val
        exit
      }
    }
  ' "$file"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "Need sha256sum or shasum to verify the official Corotum release."
  fi
}

append_path_file() {
  file=$1
  bin_dir=$2
  marker="# Added by the official Corotum installer"
  if [ -f "$file" ] && grep -F "$marker" "$file" >/dev/null 2>&1; then
    return 0
  fi
  if [ -f "$file" ] && grep -F "$bin_dir" "$file" >/dev/null 2>&1; then
    return 0
  fi
  if [ -f "$file" ] && grep -F '.local/bin' "$file" >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -f "$file" ]; then
    umask 022
    : >"$file"
  fi
  if [ "$bin_dir" = "$HOME/.local/bin" ]; then
    printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n' "$marker" >>"$file"
  else
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$bin_dir" >>"$file"
  fi
}

ensure_path() {
  bin_dir=$1
  append_path_file "$HOME/.profile" "$bin_dir"
  case ${SHELL:-} in
    *zsh)
      append_path_file "$HOME/.zshrc" "$bin_dir"
      ;;
    *bash)
      append_path_file "$HOME/.bashrc" "$bin_dir"
      if [ -f "$HOME/.bash_profile" ]; then
        append_path_file "$HOME/.bash_profile" "$bin_dir"
      fi
      ;;
  esac
  if [ -f "$HOME/.zshrc" ]; then
    append_path_file "$HOME/.zshrc" "$bin_dir"
  fi
  if [ -f "$HOME/.bashrc" ]; then
    append_path_file "$HOME/.bashrc" "$bin_dir"
  fi
}

print_banner

command -v curl >/dev/null 2>&1 || die "Need curl to download the official Corotum release."
command -v tar >/dev/null 2>&1 || die "Need tar to unpack the official Corotum release."

os=${TOOLMIRROR_OS:-}
arch=${TOOLMIRROR_ARCH:-}

if [ -z "$os" ]; then
  sys=$(uname -s)
  case "$sys" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Use the official Windows installer: irm https://corotum.com/install.ps1 | iex"
      ;;
    *) die "Unsupported OS: $sys" ;;
  esac
fi

if [ -z "$arch" ]; then
  machine=$(uname -m)
  case "$machine" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "Unsupported architecture: $machine" ;;
  esac
fi

case "$os-$arch" in
  darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) target="$os-$arch" ;;
  windows-*)
    die "Use the official Windows installer: irm https://corotum.com/install.ps1 | iex"
    ;;
  *) die "Unsupported OS/arch: $os-$arch" ;;
esac

RELEASE_BASE=${TOOLMIRROR_RELEASE_BASE:-https://releases.corotum.com}
RELEASE_BASE=${RELEASE_BASE%/}
BIN_DIR="${TOOLMIRROR_BIN_DIR:-$HOME/.local/bin}"
DEST="$BIN_DIR/corotum"
filename="corotum-$target.tar.gz"

TMP=${TMPDIR:-/tmp}
TMP=$(mktemp -d "$TMP/corotum-install.XXXXXX")
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT HUP TERM

printf '%s\n' "Fetching official release metadata for $target"

curl -fsSL "$RELEASE_BASE/releases/latest.json" -o "$TMP/latest.json" ||
  die "Failed to download official release metadata."

version=$(json_string "$TMP/latest.json" version)
[ -n "$version" ] || die "latest.json is missing version."
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  die "latest.json version is invalid."
grep -F "\"$target\"" "$TMP/latest.json" >/dev/null 2>&1 ||
  die "latest.json is missing $target."

curl -fsSL "$RELEASE_BASE/releases/v$version/checksums.txt" -o "$TMP/checksums.txt" ||
  die "Failed to download official checksums."

expected=$(awk -v file="binaries/$filename" '
  $1 ~ /^[a-f0-9]{64}$/ && $2 == file { print $1; exit }
' "$TMP/checksums.txt")
[ -n "$expected" ] || die "checksums.txt is missing binaries/$filename."
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')

printf '%s\n' "Downloading Corotum $version ($target)"
curl -fsSL "$RELEASE_BASE/releases/v$version/binaries/$filename" -o "$TMP/$filename" ||
  die "Failed to download the official Corotum archive."

actual=$(sha256_file "$TMP/$filename" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  die "SHA-256 mismatch for $filename. Existing install was not replaced."
fi

mkdir -p "$TMP/extract"
tar -xzf "$TMP/$filename" -C "$TMP/extract"
staged="$TMP/extract/corotum"
[ -f "$staged" ] || die "Official archive did not contain corotum."
chmod 755 "$staged"

set +e
version_out=$("$staged" --version)
status=$?
set -e
if [ "$status" -ne 0 ]; then
  die "Official binary failed --version. Existing install was not replaced."
fi

umask 022
mkdir -p "$BIN_DIR"
mv "$staged" "$DEST"
chmod 755 "$DEST"

ensure_path "$BIN_DIR"

printf '%s\n' "Installed $DEST"
printf '%s\n' "$version_out"
printf '%s\n' "Corotum was installed with the official installer."
