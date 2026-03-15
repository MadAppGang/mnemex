#!/bin/bash
# mnemex installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudemem/main/install.sh | bash

set -e

REPO="MadAppGang/claudemem"
INSTALL_DIR="${MNEMEX_INSTALL_DIR:-$HOME/.local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[success]${NC} $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; exit 1; }

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux";;
        Darwin*) os="darwin";;
        MINGW*|MSYS*|CYGWIN*) error "Windows detected. Use: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex";;
        *) error "Unsupported OS: $(uname -s)";;
    esac

    case "$(uname -m)" in
        x86_64|amd64)  arch="x64";;
        arm64|aarch64) arch="arm64";;
        *) error "Unsupported architecture: $(uname -m)";;
    esac

    echo "${os}-${arch}"
}

get_latest_version() {
    curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | \
        grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/'
}

compute_sha256() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

verify_checksum() {
    local file="$1" version="$2" platform="$3"
    local checksums_url="https://github.com/${REPO}/releases/download/v${version}/checksums.txt"
    local expected actual

    expected=$(curl -fsSL "$checksums_url" 2>/dev/null | grep "mnemex-${platform}" | cut -d' ' -f1)

    if [ -z "$expected" ]; then
        warn "Checksums not available, skipping verification"
        return 0
    fi

    actual=$(compute_sha256 "$file")

    if [ -z "$actual" ]; then
        warn "No sha256 tool found, skipping verification"
        return 0
    fi

    if [ "$expected" != "$actual" ]; then
        error "Checksum mismatch!\n  Expected: ${expected}\n  Got:      ${actual}"
    fi

    success "Checksum verified"
}

install() {
    local platform version download_url tmp_file

    platform=$(detect_platform)
    info "Platform: ${CYAN}${platform}${NC}"

    version=$(get_latest_version)
    [ -z "$version" ] && error "Could not determine latest version"
    info "Version: ${CYAN}v${version}${NC}"

    download_url="https://github.com/${REPO}/releases/download/v${version}/mnemex-${platform}"
    info "Downloading: ${download_url}"

    tmp_file=$(mktemp)
    curl -fsSL "$download_url" -o "$tmp_file" || error "Download failed"

    verify_checksum "$tmp_file" "$version" "$platform"

    mkdir -p "$INSTALL_DIR"
    chmod +x "$tmp_file"
    mv "$tmp_file" "${INSTALL_DIR}/mnemex"

    success "Installed to ${INSTALL_DIR}/mnemex"

    if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
        warn "${INSTALL_DIR} is not in PATH"
        echo ""
        echo "Add to your shell config:"
        echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
    fi
}

main() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${GREEN}mnemex${NC} installer                    ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Local code indexing for Claude        ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
    echo ""

    command -v curl &>/dev/null || error "curl is required"

    install

    echo ""
    success "Installation complete!"
    echo ""
    echo "Quick start:"
    echo "  ${CYAN}mnemex init${NC}            # Set up API key"
    echo "  ${CYAN}mnemex index${NC}           # Index your codebase"
    echo "  ${CYAN}mnemex search \"...\"${NC}   # Search code"
    echo ""
    echo "MCP server (Claude Code integration):"
    echo "  ${CYAN}mnemex --mcp${NC}"
    echo ""
}

main "$@"
