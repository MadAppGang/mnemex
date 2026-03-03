#!/usr/bin/env bun

/**
 * claudemem - Local code indexing tool for Claude Code
 *
 * Entry point that supports two modes:
 * - CLI mode (default): Interactive command-line interface
 * - MCP mode (--mcp): Model Context Protocol server for Claude Code integration
 */

import { config } from "dotenv";

// Load environment variables from .env file
config();

const args = process.argv.slice(2);

// Check for MCP server mode
const isMcpMode = args.includes("--mcp");
const isAutocompleteServerMode = args.includes("--autocomplete-server");

if (isAutocompleteServerMode) {
	// Autocomplete server mode (JSONL-RPC over stdio)
	const projectIdx = args.findIndex((a) => a === "--project");
	const projectPath = projectIdx !== -1 ? args[projectIdx + 1] : undefined;

	import("./autocomplete/server.js").then((module) => {
		module.startAutocompleteServer({ projectPath });
	});
} else if (isMcpMode) {
	// MCP server mode - lazy load to keep CLI startup fast
	import("./mcp/server.js").then((module) => {
		module.startMcpServer();
	});
} else {
	// CLI mode
	import("./cli.js").then((module) => {
		module.runCli(args);
	});
}
