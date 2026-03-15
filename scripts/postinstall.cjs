#!/usr/bin/env node

/**
 * Post-install script for mnemex
 * Shows helpful usage information after npm/bun install
 */

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

console.log(`
${GREEN}✓ mnemex installed successfully!${RESET}

${BOLD}Quick Start:${RESET}
  ${CYAN}mnemex init${RESET}          Set up API key and model
  ${CYAN}mnemex index${RESET}         Index current project
  ${CYAN}mnemex search${RESET} "query"  Search indexed code

${BOLD}MCP Server (for Claude Code):${RESET}
  ${CYAN}mnemex --mcp${RESET}         Start as MCP server

${DIM}Documentation: https://github.com/MadAppGang/claudemem${RESET}
`);
