/**
 * Claude Code Hook Dispatcher
 *
 * Reads hook input from stdin, dispatches to appropriate handler,
 * and writes output to fd 3 (or stdout as fallback).
 */

import { writeFileSync } from "node:fs";
import type { HookInput, HookOutput, HookOptions } from "./types.js";

// ============================================================================
// Stdin/Output Utilities
// ============================================================================

/**
 * Read JSON from stdin using Bun-compatible approach
 */
async function readStdin(): Promise<string> {
	// Check if running in Bun
	const isBun = typeof globalThis.Bun !== "undefined";

	if (isBun) {
		// Bun: use Bun.stdin directly
		const text = await Bun.stdin.text();
		return text;
	}

	// Node.js fallback
	const chunks: string[] = [];
	process.stdin.setEncoding("utf-8");

	for await (const chunk of process.stdin) {
		chunks.push(chunk as string);
	}

	return chunks.join("");
}

/**
 * Write output to fd 3 (Claude Code's expected output) or stdout
 */
function writeOutput(output: HookOutput): void {
	const json = JSON.stringify(output);

	try {
		// Try fd 3 first (Claude Code's hook output channel)
		writeFileSync(3, json);
	} catch {
		// Fall back to stdout
		console.log(json);
	}
}

// ============================================================================
// Main Dispatcher
// ============================================================================

/**
 * Main hook dispatcher - reads stdin, routes to handler, writes output
 */
export async function handleHook(options: HookOptions = {}): Promise<void> {
	const { debug = false } = options;

	// Read input
	const inputJson = await readStdin();
	if (!inputJson.trim()) {
		if (debug) console.error("Empty stdin");
		return;
	}

	// Parse input
	let input: HookInput;
	try {
		input = JSON.parse(inputJson);
	} catch (error) {
		throw new Error(`Failed to parse hook input: ${error}`);
	}

	if (debug) {
		console.error(`Hook: ${input.hook_event_name} ${input.tool_name || ""}`);
	}

	// Dispatch to handler (lazy imports for fast startup)
	let output: HookOutput | null = null;

	switch (input.hook_event_name) {
		case "SessionStart": {
			const { handleSessionStart } = await import(
				"./handlers/session-start.js"
			);
			output = await handleSessionStart(input);
			break;
		}

		case "PreToolUse": {
			const { handlePreToolUse } = await import("./handlers/pre-tool-use.js");
			output = await handlePreToolUse(input);
			break;
		}

		case "PostToolUse": {
			const { handlePostToolUse } = await import("./handlers/post-tool-use.js");
			output = await handlePostToolUse(input);
			break;
		}

		case "Stop":
		case "SubagentStop":
			// No action needed for these events currently
			break;

		default:
			if (debug) {
				console.error(`Unknown hook event: ${input.hook_event_name}`);
			}
	}

	// Write output if any
	if (output) {
		writeOutput(output);
	}
}
