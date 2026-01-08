#!/usr/bin/env node

/**
 * Post-install script for claudemem
 * Shows helpful usage information after npm/bun install
 */

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

console.log(`
${GREEN}✓ claudemem installed successfully!${RESET}

${BOLD}Quick Start:${RESET}
  ${CYAN}claudemem init${RESET}          Set up API key and model
  ${CYAN}claudemem index${RESET}         Index current project
  ${CYAN}claudemem search${RESET} "query"  Search indexed code

${BOLD}MCP Server (for Claude Code):${RESET}
  ${CYAN}claudemem --mcp${RESET}         Start as MCP server

${DIM}Documentation: https://github.com/MadAppGang/claudemem${RESET}
`);
