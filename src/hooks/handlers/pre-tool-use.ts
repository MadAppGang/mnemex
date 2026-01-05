/**
 * PreToolUse Hook Handler
 *
 * Intercepts tool calls before execution:
 * - Grep: Replace with claudemem AST analysis
 * - Bash: Detect grep/find commands and intercept
 * - Glob: Provide tips about semantic search
 * - Read: Track for potential feedback (future)
 * - All tools: Log tool start for interaction monitoring
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { HookInput, HookOutput, IndexStatus } from "../types.js";
import { logToolStart } from "./interaction-logger.js";

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if project is indexed
 */
function isIndexed(cwd: string): IndexStatus {
	const indexDir = join(cwd, ".claudemem");
	const dbPath = join(indexDir, "index.db");

	if (!existsSync(dbPath)) {
		return { indexed: false };
	}

	return { indexed: true, symbolCount: "available" };
}

/**
 * Run claudemem command and return output
 */
function runClaudemem(args: string[], cwd?: string): string | null {
	try {
		const result = spawnSync(process.execPath, [process.argv[1], ...args], {
			cwd,
			encoding: "utf-8",
			timeout: 10000,
		});

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
			additionalContext: `**claudemem not indexed** - Grep allowed as fallback.

For AST structural analysis, run:
\`\`\`bash
claudemem index
\`\`\``,
		};
	}

	// Determine best command based on pattern
	let results: string | null = null;
	let commandUsed = "map";

	// If pattern looks like a symbol name, try symbol lookup first
	if (/^[A-Z][a-zA-Z0-9]*$|^[a-z][a-zA-Z0-9_]*$/.test(pattern)) {
		results = runClaudemem(["--nologo", "symbol", pattern, "--raw"], input.cwd);
		if (results && !results.includes("No results") && results.trim()) {
			commandUsed = "symbol";
		} else {
			results = null;
		}
	}

	// Fallback to map
	if (!results) {
		results =
			runClaudemem(["--nologo", "map", pattern, "--raw"], input.cwd) ||
			"No results found";
		commandUsed = "map";
	}

	return {
		additionalContext: `**CLAUDEMEM AST ANALYSIS** (Grep intercepted)

**Query:** "${pattern}"
**Command:** claudemem --nologo ${commandUsed} "${pattern}" --raw

${results}

---
AST structural analysis complete.

**Commands:**
- \`claudemem --nologo symbol <name> --raw\` - Exact location
- \`claudemem --nologo callers <name> --raw\` - What calls this?
- \`claudemem --nologo callees <name> --raw\` - What does this call?
- \`claudemem --nologo context <name> --raw\` - Full call chain`,
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason:
				"Grep replaced with claudemem AST analysis. Results provided in context.",
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
			additionalContext: `**Search command detected but claudemem not indexed**

Command: \`${command}\`

For AST structural analysis, run \`claudemem index\` first.
Allowing command as fallback.`,
		};
	}

	// Run claudemem instead
	const results =
		runClaudemem(["--nologo", "map", extractedPattern, "--raw"], input.cwd) ||
		"No results found";

	return {
		additionalContext: `**CLAUDEMEM AST ANALYSIS** (Bash search intercepted)

**Original command:** \`${command}\`
**Pattern extracted:** "${extractedPattern}"
**Replaced with:** claudemem --nologo map "${extractedPattern}" --raw

${results}

---
Use claudemem for structural analysis instead of grep/find.`,
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `Bash search replaced with claudemem. Pattern "${extractedPattern}" analyzed with AST.`,
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
			additionalContext: `**Tip:** Consider claudemem for semantic search:
\`\`\`bash
claudemem index  # First time only
claudemem --nologo map "your query" --raw
\`\`\``,
		};
	}

	// Don't block Glob, just add tips
	return {
		additionalContext: `**Tip:** For semantic code search, use claudemem:
\`\`\`bash
claudemem --nologo map "component" --raw   # Find by concept
claudemem --nologo symbol "Button" --raw   # Find by name
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
