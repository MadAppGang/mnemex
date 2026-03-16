/**
 * PostToolUse Hook Handler
 *
 * Runs after tool execution completes:
 * - Write/Edit: Auto-reindex code files (debounced, background)
 * - All tools: Log tool completion for interaction monitoring
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname } from "node:path";
import type { HookInput, HookOutput } from "../types.js";
import { logToolCompletion } from "./interaction-logger.js";

// ============================================================================
// Constants
// ============================================================================

/** Code file extensions that should trigger reindexing */
const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
	".scala",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".php",
	".vue",
	".svelte",
]);

/** Debounce time in seconds between reindex operations */
const DEBOUNCE_SECONDS = 30;

// ============================================================================
// Auto-Reindex Handler
// ============================================================================

/**
 * Auto-reindex after file changes
 */
async function handleAutoReindex(input: HookInput): Promise<HookOutput | null> {
	// Get file path from response or input
	const filePath = (input.tool_response?.filePath ||
		input.tool_input?.file_path) as string;
	if (!filePath) return null;

	// Check if code file
	const ext = extname(filePath).toLowerCase();
	if (!CODE_EXTENSIONS.has(ext)) return null;

	// Check if project is indexed
	const indexDir = join(input.cwd, ".mnemex");
	if (!existsSync(indexDir)) return null;

	// Debounce check
	const debounceFile = join(indexDir, ".reindex-timestamp");
	const lockFile = join(indexDir, ".reindex-lock");

	if (existsSync(debounceFile)) {
		try {
			const lastReindex = parseInt(readFileSync(debounceFile, "utf-8"), 10);
			const elapsed = Math.floor(Date.now() / 1000) - lastReindex;
			if (elapsed < DEBOUNCE_SECONDS) {
				return null; // Debounced
			}
		} catch {
			// Ignore read errors
		}
	}

	// Check lock file for running process
	if (existsSync(lockFile)) {
		try {
			const pid = parseInt(readFileSync(lockFile, "utf-8"), 10);
			try {
				process.kill(pid, 0); // Throws if not running
				return null; // Still running
			} catch (err) {
				const error = err as NodeJS.ErrnoException;
				if (error.code === "ESRCH") {
					// Process not found - remove stale lock
					rmSync(lockFile, { force: true });
				} else if (error.code === "EPERM") {
					// Process exists but owned by another user - skip reindex
					return null;
				} else {
					// Unknown error - skip reindex to be safe
					return null;
				}
			}
		} catch {
			// Ignore lock file read errors
		}
	}

	// Update timestamp
	writeFileSync(debounceFile, Math.floor(Date.now() / 1000).toString());

	// Spawn background reindex
	const child = spawn(process.execPath, [process.argv[1], "index", "--quiet"], {
		cwd: input.cwd,
		detached: true,
		stdio: "ignore",
	});

	// Write PID to lock file and register cleanup handler BEFORE unref()
	if (child.pid) {
		writeFileSync(lockFile, child.pid.toString());

		// Clean up lock file when process exits
		// NOTE: Must register before unref() to ensure handler is attached
		child.on("exit", () => {
			try {
				rmSync(lockFile, { force: true });
			} catch {
				// Ignore cleanup errors
			}
		});

		// Allow parent to exit without waiting for child
		child.unref();
	} else {
		// No PID means spawn failed, clean up
		child.unref();
	}

	return null; // No context for background operation
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle PostToolUse hook events
 */
export async function handlePostToolUse(
	input: HookInput,
): Promise<HookOutput | null> {
	// Log tool completion for interaction monitoring
	try {
		logToolCompletion(input);
	} catch {
		// Don't fail the hook if logging fails
	}

	// Handle auto-reindex for code files
	if (input.tool_name === "Write" || input.tool_name === "Edit") {
		return handleAutoReindex(input);
	}
	return null;
}
