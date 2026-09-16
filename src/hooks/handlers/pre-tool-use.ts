/**
 * PreToolUse Hook Handler
 *
 * Intercepts tool calls before execution:
 * - Grep: Replace with mnemex AST analysis
 * - Bash: Detect grep/find commands and intercept
 * - Glob: Provide tips about semantic search
 * - Read: Track for potential feedback (future)
 * - All tools: Log tool start for interaction monitoring
 */

import { existsSync } from "node:fs";
import { getIndexDbPath } from "../../config.js";
import { runSelfSync } from "../../core/entry-point-launcher.js";
import type { HookInput, HookOutput, IndexStatus } from "../types.js";
import { logToolStart } from "./interaction-logger.js";

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if project is indexed.
 *
 * Through the seam (FR-3, decision I-8), never `join(cwd, ".mnemex", …)`. This
 * was one of the four files on `MNEMEX_STORE_PATH_ALLOWLIST`, and the entry was
 * a deferral rather than a justification (`phase-3b-inputs.md` §7). From Phase
 * 3c the store is `<gitCommonDir>/mnemex`, so the hand-built path probes a
 * directory nothing writes: this hook would report EVERY indexed repository as
 * un-indexed and tell the user to run `mnemex index` after they just had.
 */
function isIndexed(cwd: string): IndexStatus {
	if (!existsSync(getIndexDbPath(cwd))) {
		return { indexed: false };
	}

	return { indexed: true, symbolCount: "available" };
}

/**
 * Run mnemex command and return output
 */
function runMnemex(args: string[], cwd?: string): string | null {
	try {
		// `process.execPath` + `process.argv[1]` re-executes THIS build's own
		// script — in production that is `dist/index.js`, i.e. the entry point
		// under a name containing neither "mnemex" nor "index". Routed through the
		// one launcher so the static sweep can see it and the runtime veto covers
		// it; see `src/core/entry-point-launcher.ts`.
		const result = runSelfSync(args, cwd, 10000);

		if (result.status === 0) {
			return result.stdout?.trim() || null;
		}
		return null;
	} catch {
		return null;
	}
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Intercept Grep tool - replace with AST analysis
 */
async function handleGrepIntercept(
	input: HookInput,
): Promise<HookOutput | null> {
	const pattern = input.tool_input?.pattern;
	if (!pattern) return null;

	const status = isIndexed(input.cwd);
	if (!status.indexed) {
		return {
			additionalContext: `**mnemex not indexed** - Grep allowed as fallback.

For AST structural analysis, run:
\`\`\`bash
mnemex index
\`\`\``,
		};
	}

	// Determine best command based on pattern
	let results: string | null = null;
	let commandUsed = "map";

	// If pattern looks like a symbol name, try symbol lookup first
	if (/^[A-Z][a-zA-Z0-9]*$|^[a-z][a-zA-Z0-9_]*$/.test(pattern)) {
		results = runMnemex(["--nologo", "symbol", pattern, "--raw"], input.cwd);
		if (results && !results.includes("No results") && results.trim()) {
			commandUsed = "symbol";
		} else {
			results = null;
		}
	}

	// Fallback to map
	if (!results) {
		results =
			runMnemex(["--nologo", "map", pattern, "--raw"], input.cwd) ||
			"No results found";
		commandUsed = "map";
	}

	return {
		additionalContext: `**MNEMEX AST ANALYSIS** (Grep intercepted)

**Query:** "${pattern}"
**Command:** mnemex --nologo ${commandUsed} "${pattern}" --raw

${results}

---
AST structural analysis complete.

**Commands:**
- \`mnemex --nologo symbol <name> --raw\` - Exact location
- \`mnemex --nologo callers <name> --raw\` - What calls this?
- \`mnemex --nologo callees <name> --raw\` - What does this call?
- \`mnemex --nologo context <name> --raw\` - Full call chain`,
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason:
				"Grep replaced with mnemex AST analysis. Results provided in context.",
		},
	};
}

/**
 * Intercept Bash tool - detect grep/find commands
 */
async function handleBashIntercept(
	input: HookInput,
): Promise<HookOutput | null> {
	const command = input.tool_input?.command;
	if (!command) return null;

	// Patterns that indicate search commands
	const searchPatterns = [
		/\bgrep\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/,
		/\brg\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/,
		/\bag\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/,
		/\back\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/,
		/\bfind\s+.*-i?name\s+["']?\*?([^"'\s*]+)/,
	];

	// Extract search pattern
	let extractedPattern: string | null = null;
	for (const regex of searchPatterns) {
		const match = command.match(regex);
		if (match) {
			extractedPattern = match[1];
			break;
		}
	}

	if (!extractedPattern) return null;

	const status = isIndexed(input.cwd);
	if (!status.indexed) {
		return {
			additionalContext: `**Search command detected but mnemex not indexed**

Command: \`${command}\`

For AST structural analysis, run \`mnemex index\` first.
Allowing command as fallback.`,
		};
	}

	// Run mnemex instead
	const results =
		runMnemex(["--nologo", "map", extractedPattern, "--raw"], input.cwd) ||
		"No results found";

	return {
		additionalContext: `**MNEMEX AST ANALYSIS** (Bash search intercepted)

**Original command:** \`${command}\`
**Pattern extracted:** "${extractedPattern}"
**Replaced with:** mnemex --nologo map "${extractedPattern}" --raw

${results}

---
Use mnemex for structural analysis instead of grep/find.`,
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `Bash search replaced with mnemex. Pattern "${extractedPattern}" analyzed with AST.`,
		},
	};
}

/**
 * Intercept Glob tool - provide tips (don't block)
 */
async function handleGlobIntercept(
	input: HookInput,
): Promise<HookOutput | null> {
	const status = isIndexed(input.cwd);

	if (!status.indexed) {
		return {
			additionalContext: `**Tip:** Consider mnemex for semantic search:
\`\`\`bash
mnemex index  # First time only
mnemex --nologo map "your query" --raw
\`\`\``,
		};
	}

	// Don't block Glob, just add tips
	return {
		additionalContext: `**Tip:** For semantic code search, use mnemex:
\`\`\`bash
mnemex --nologo map "component" --raw   # Find by concept
mnemex --nologo symbol "Button" --raw   # Find by name
\`\`\``,
	};
}

/**
 * Intercept Read tool - track for feedback (future)
 */
async function handleReadIntercept(
	_input: HookInput,
): Promise<HookOutput | null> {
	// Currently no action - could track reads for feedback in future
	return null;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle PreToolUse hook events
 */
export async function handlePreToolUse(
	input: HookInput,
): Promise<HookOutput | null> {
	// Log tool start for interaction monitoring
	try {
		logToolStart(input);
	} catch {
		// Don't fail the hook if logging fails
	}

	switch (input.tool_name) {
		case "Grep":
			return handleGrepIntercept(input);
		case "Bash":
			return handleBashIntercept(input);
		case "Glob":
			return handleGlobIntercept(input);
		case "Read":
			return handleReadIntercept(input);
		default:
			return null;
	}
}
