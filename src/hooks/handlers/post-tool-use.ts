/**
 * PostToolUse Hook Handler
 *
 * Runs after tool execution completes:
 * - Write/Edit: Auto-reindex code files (debounced, background)
 * - All tools: Log tool completion for interaction monitoring
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { getIndexDbPath, getWorktreeDir } from "../../config.js";
import {
	type EntryPointProcess,
	spawnSelfDetached,
} from "../../core/entry-point-launcher.js";
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

	// Is this project indexed? Through the seam (FR-3), like the other three
	// hooks: `index.db` is the store's, wherever the store is.
	if (!existsSync(getIndexDbPath(input.cwd))) return null;

	// ── THE THIRD LOCK (phase-3b-inputs.md §6, item 3) ────────────────────────
	//
	// JUSTIFIED IN WRITING AS A SEPARATE CONCERN, per §6's second option, and
	// MOVED to the per-worktree directory (§2.4) so that Phase 3c's flip does not
	// make it the store's third lock by accident.
	//
	// WHAT IT GUARDS, and why it is not the store lock's job. This pair is a
	// DEBOUNCE over one editor session's keystrokes: "have I already asked for a
	// reindex in the last 30 seconds, and is the process I asked still alive?".
	// It protects nothing in the dataset. Its whole purpose is to avoid SPAWNING
	// a second `mnemex index --quiet`; the store lock's purpose is to make two
	// index runs that DO start safe against each other, and it does that
	// correctly whether or not this file exists. Delete this pair and no row is
	// at risk — you get redundant child processes that then serialise on the real
	// lock. They are different questions and the answers do not substitute.
	//
	// WHY IT MUST NOT BECOME THE STORE LOCK. The store lock is held for the
	// DURATION of an index run (minutes on a large repository). Taking it here
	// would block a `PostToolUse` hook — which runs after every Write and Edit —
	// for that whole time, stalling the editor. Worse, the debounce must answer
	// "is one already queued?" WITHOUT waiting, and a lock whose contract is to
	// wait cannot answer that question at all.
	//
	// WHY PER-WORKTREE, AND WHY THAT IS THE POINT. The debounce is a property of
	// ONE checkout's editing session, so two worktrees being edited at once must
	// each get their own reindex. A shared debounce would let a colleague's edit
	// suppress yours for 30 s and leave your worktree stale. `getWorktreeDir`
	// keeps it in `<worktreeRoot>/.mnemex` under both scopes — which is also a
	// FIX from `join(input.cwd, ".mnemex")`: with the hook's cwd below the root,
	// the old spelling made a per-SUBDIRECTORY debounce that never saw the
	// sibling's.
	//
	// The store may now live elsewhere, so the per-worktree directory is no
	// longer guaranteed to exist. Created here; a failure is swallowed, like
	// every other failure in this best-effort hook.
	const worktreeDir = getWorktreeDir(input.cwd);
	try {
		mkdirSync(worktreeDir, { recursive: true });
	} catch {
		return null;
	}
	const debounceFile = join(worktreeDir, ".reindex-timestamp");
	const lockFile = join(worktreeDir, ".reindex-lock");

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

	// Spawn background reindex. `process.execPath` + `process.argv[1]` re-executes
	// this build's own script, which IS the entry point — routed through the one
	// launcher so the static sweep can see it and the runtime veto covers it. See
	// `src/core/entry-point-launcher.ts`.
	let child: EntryPointProcess;
	try {
		child = spawnSelfDetached(["index", "--quiet"], input.cwd);
	} catch {
		// The launcher refuses in a guarded (test) process. The hook's own work is
		// already done; the background reindex is best-effort.
		return null;
	}

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
