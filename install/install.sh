#!/usr/bin/env bash
#
# syncengine installer.
#
#   curl -fsSL <install-url> | bash
#
# What this does:
#   1. Detects your platform (darwin/linux + x64/arm64)
#   2. Downloads the matching binary from the latest GitHub Release
#   3. Installs to $HOME/.syncengine/bin/syncengine
#   4. Suggests a PATH update for your shell
#
# Uninstall with:
#   rm -rf $HOME/.syncengine
#   # then remove the PATH line from your shell rc
#
# Override defaults:
#   SYNCENGINE_INSTALL  — install root (default $HOME/.syncengine)
#   SYNCENGINE_VERSION  — pinned release tag (default: latest)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
# REPO is the GitHub "owner/name" where binaries are published. Pinned here
# until we have a real domain; the installer can also be hosted under a
# CNAME once DNS exists.
REPO="__SYNCENGINE_REPO__"
INSTALL_ROOT="${SYNCENGINE_INSTALL:-$HOME/.syncengine}"
BIN_DIR="$INSTALL_ROOT/bin"
VERSION="${SYNCENGINE_VERSION:-latest}"

# ── Terminal helpers ──────────────────────────────────────────────────────
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; RED=""; RESET=""
fi

log()  { printf "  %s\n" "$*"; }
step() { printf "${BOLD}▸${RESET} %s\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

die() {
  err "$*"
  exit 1
}

# ── Platform detection ────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    msys*|cygwin*|mingw*) die "Windows install via curl isn't supported yet. Grab the .zip from github.com/$REPO/releases." ;;
    *)      die "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# ── Download + install ────────────────────────────────────────────────────
main() {
  printf "\n"
  step "syncengine installer"
  printf "\n"

  command -v curl >/dev/null 2>&1 || die "curl is required."
  command -v tar  >/dev/null 2>&1 || die "tar is required."

  local platform url dest tmpdir
  platform="$(detect_platform)"
  log "${DIM}platform: ${platform}${RESET}"

  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/$REPO/releases/latest/download/syncengine-${platform}.tar.gz"
  else
    url="https://github.com/$REPO/releases/download/${VERSION}/syncengine-${platform}.tar.gz"
  fi

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  step "downloading binary"
  log "${DIM}${url}${RESET}"
  if ! curl --fail --location --silent --show-error --output "$tmpdir/syncengine.tar.gz" "$url"; then
    die "download failed. If the release doesn't exist yet, check github.com/$REPO/releases."
  fi
  ok "downloaded"

  step "extracting"
  tar -xzf "$tmpdir/syncengine.tar.gz" -C "$tmpdir"
  [ -f "$tmpdir/syncengine" ] || die "archive did not contain the expected 'syncengine' binary."

  step "installing to $BIN_DIR"
  mkdir -p "$BIN_DIR"
  dest="$BIN_DIR/syncengine"
  mv "$tmpdir/syncengine" "$dest"
  chmod +x "$dest"
  ok "installed $dest"

  # ── Shell PATH nudge ────────────────────────────────────────────────
  printf "\n"
  if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
    step "add to your PATH"
    printf "  Run one of these (or add the line to your shell rc yourself):\n\n"

    local path_line="export PATH=\"$BIN_DIR:\$PATH\""
    local shell_name
    shell_name="$(basename "${SHELL:-}")"

    case "$shell_name" in
      zsh)  printf "    ${BOLD}echo '%s' >> ~/.zshrc && source ~/.zshrc${RESET}\n\n" "$path_line" ;;
      bash) printf "    ${BOLD}echo '%s' >> ~/.bashrc && source ~/.bashrc${RESET}\n\n" "$path_line" ;;
      fish) printf "    ${BOLD}fish_add_path %s${RESET}\n\n" "$BIN_DIR" ;;
      *)    printf "    ${BOLD}%s${RESET}\n\n" "$path_line" ;;
    esac
  else
    ok "$BIN_DIR already on PATH"
  fi

  printf "${BOLD}${GREEN}syncengine is installed.${RESET}\n\n"
  printf "Verify:     ${BOLD}syncengine --version${RESET}\n"
  printf "Get going:  ${BOLD}syncengine init my-app${RESET}\n\n"
}

main "$@"
