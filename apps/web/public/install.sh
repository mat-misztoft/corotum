#!/bin/sh
# Official Corotum installer.
# This is the only officially supported installation method.
# Manual binary download is not an officially supported installation method.
# v0.5 binaries are unsigned.

set -eu

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

print_banner() {
  cat <<'BANNER'
,-----.                       ,--.                     
'  .--./ ,---. ,--.--. ,---. ,-'  '-.,--.,--.,--,--,--. 
|  |    | .-. ||  .--'| .-. |'-.  .-'|  ||  ||        | 
'  '--'\' '-' '|  |   ' '-' '  |  |  '  ''  '|  |  |  | 
 `-----' `---' `--'    `---'   `--'   `----' `--`--`--' 
BANNER
  printf '%s\n' "Official Corotum installer"
  printf '%s\n' "This is the only officially supported installation method."
  printf '%s\n' "Manual binary download is not an officially supported installation method."
  printf '%s\n' "v0.5 binaries are unsigned."
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

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

append_path_file() {
  file=$1
  if [ -f "$file" ] && grep -Fx "$path_line" "$file" >/dev/null 2>&1; then
    return 0
  fi
  if ! (printf '\n%s\n%s\n' "# Added by the official Corotum installer" "$path_line" >>"$file"); then
    printf 'Warning: Could not update %s.\n' "$file" >&2
    path_failed=1
  fi
}

ensure_path() {
  path_failed=0
  path_line="export PATH=$(shell_quote "$BIN_DIR"):\"\$PATH\""
  if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
    path_line='export PATH="$HOME/.local/bin:$PATH"'
  fi
  case ${SHELL:-} in
    */zsh)
      append_path_file "$HOME/.profile"
      append_path_file "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    */bash)
      append_path_file "$HOME/.profile"
      append_path_file "$HOME/.bashrc"
      if [ -f "$HOME/.bash_profile" ]; then
        append_path_file "$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ]; then
        append_path_file "$HOME/.bash_login"
      fi
      ;;
    */sh | */dash | */ksh)
      append_path_file "$HOME/.profile"
      ;;
    *)
      printf 'Warning: Unsupported shell for automatic PATH setup: %s\n' "${SHELL:-unknown}" >&2
      path_failed=1
      ;;
  esac
}

print_banner

command -v curl >/dev/null 2>&1 || die "Need curl to download the official Corotum release."
command -v tar >/dev/null 2>&1 || die "Need tar to unpack the official Corotum release."

os=${COROTUM_OS:-}
arch=${COROTUM_ARCH:-}

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

RELEASE_BASE=${COROTUM_RELEASE_BASE:-https://releases.corotum.com}
RELEASE_BASE=${RELEASE_BASE%/}
BIN_DIR="${COROTUM_BIN_DIR:-$HOME/.local/bin}"
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

ensure_path

printf '%s\n' "Installed $DEST"
printf '%s\n' "$version_out"
printf '%s\n' "Corotum was installed with the official installer."
printf '%s\n' ""
if [ "$path_failed" -eq 0 ]; then
  printf '%s\n' "PATH configured. Open a new terminal and run: corotum init"
else
  printf '%s\n' "Corotum is installed, but automatic PATH setup did not complete."
  printf '%s\n' "Add $BIN_DIR to PATH in your shell startup file."
  case ${SHELL:-} in
    */bash | */zsh | */sh | */dash | */ksh)
      printf '%s\n' "To use Corotum in this terminal, run:" "  $path_line" "  corotum init"
      ;;
  esac
fi
printf '%s\n' "To configure this device now without restarting the terminal, run:"
printf '  %s init\n' "$(shell_quote "$DEST")"
printf '%s\n' ""
printf '%s\n' "Get started"
printf '%s\n' "  corotum init        Configure this device"
printf '%s\n' "  corotum status      Show local sync state"
printf '%s\n' "  corotum --help      View all commands"
