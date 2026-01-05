/**
 * SessionStart Hook Handler
 *
 * Runs when Claude Code session starts:
 * - Cleans up old temporary session directories
 * - Checks claudemem version and index status
 * - Initializes interaction monitoring
 * - Returns context about available features
 */

import { existsSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { HookInput, HookOutput, IndexStatus } from "../types.js";
import { logSessionStart, cleanupStaleSessions } from "./interaction-logger.js";

// ============================================================================
// Version Utilities
// ============================================================================

/** Cached version */
let _version: string | null = null;

/**
 * Get claudemem version from package.json
 */
function getVersion(): string | null {
	if (_version) return _version;

	try {
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const paths = [
			join(__dirname, "../../../package.json"),
			join(__dirname, "../../package.json"),
			join(process.cwd(), "package.json"),
		];

		for (const path of paths) {
			if (existsSync(path)) {
				const pkg = JSON.parse(readFileSync(path, "utf-8"));
				if (pkg.name === "claude-codemem" || pkg.name === "claudemem") {
					_version = pkg.version || null;
					return _version;
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return null;
}

/**
 * Compare semantic versions (returns true if version >= required)
 */
function versionGte(version: string, required: string): boolean {
	const v1 = version.split(".").map(Number);
	const v2 = required.split(".").map(Number);

	for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
		const a = v1[i] || 0;
		const b = v2[i] || 0;
		if (a > b) return true;
		if (a < b) return false;
	}
	return true;
}

// ============================================================================
// Index Status Utilities
// ============================================================================

/**
 * Check if project is indexed
 */
function isIndexed(cwd: string): IndexStatus {
	const indexDir = join(cwd, ".claudemem");
	if (!existsSync(indexDir)) {
		return { indexed: false };
	}

	const dbPath = join(indexDir, "index.db");
	if (!existsSync(dbPath)) {
		return { indexed: false };
	}

	// Try to get symbol count from status command
	try {
		const result = spawnSync(
			process.execPath,
			[process.argv[1], "status", "--nologo"],
			{
				cwd,
				encoding: "utf-8",
				timeout: 5000,
			},
		);

		if (result.status === 0 && result.stdout) {
			// Look for chunk/file count in output
			const match = result.stdout.match(/(\d+)\s+(chunks|files|symbols)/i);
			if (match) {
				return { indexed: true, symbolCount: match[0] };
			}
		}
		return { indexed: true, symbolCount: "available" };
	} catch {
		return { indexed: true, symbolCount: "available" };
	}
}

// ============================================================================
// Session Cleanup
// ============================================================================

/**
 * Clean up old session directories (TTL: 24 hours)
 */
function cleanupOldSessions(): number {
	const tmpDir = "/tmp";
	const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
	let cleaned = 0;

	try {
		const prefixes = ["analysis-", "review-", "plan-review-"];
		const entries = readdirSync(tmpDir);

		for (const entry of entries) {
			if (!prefixes.some((p) => entry.startsWith(p))) continue;

			const fullPath = join(tmpDir, entry);
			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory() && stat.mtimeMs < oneDayAgo) {
					rmSync(fullPath, { recursive: true, force: true });
					cleaned++;
				}
			} catch {
				// Ignore individual directory errors
			}
		}
	} catch {
		// Ignore cleanup errors
	}

	return cleaned;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle SessionStart hook event
 */
export async function handleSessionStart(
	input: HookInput,
): Promise<HookOutput> {
	// Clean up old sessions (temp directories)
	const cleaned = cleanupOldSessions();

	// Initialize interaction monitoring
	try {
		logSessionStart(input);
		cleanupStaleSessions(input.cwd);
	} catch {
		// Don't fail the hook if logging fails
	}

	// Get claudemem version
	const version = getVersion();
	if (!version) {
		return {
			additionalContext: `**claudemem not properly installed**

Reinstall with:
\`\`\`bash
npm install -g claude-codemem@latest
claudemem init
claudemem index
\`\`\``,
		};
	}

	// Check minimum version
	if (!versionGte(version, "0.3.0")) {
		return {
			additionalContext: `**claudemem update required**

Current: v${version}
Required: v0.3.0+

Update with:
\`\`\`bash
npm install -g claude-codemem@latest
claudemem index
\`\`\``,
		};
	}

	// Build feature message based on version
	const hasV4 = versionGte(version, "0.4.0");
	const hasV8 = versionGte(version, "0.8.0");

	let featureMsg = `**claudemem v${version}**\n\n`;

	if (hasV8) {
		featureMsg += `Available commands:
- **AST**: \`map\`, \`symbol\`, \`callers\`, \`callees\`, \`context\`, \`search\`
- **Analysis**: \`dead-code\`, \`test-gaps\`, \`impact\`
- **Learning**: \`feedback\` (search result feedback)`;
	} else if (hasV4) {
		featureMsg += `Available commands:
- **v0.3.0**: \`map\`, \`symbol\`, \`callers\`, \`callees\`, \`context\`, \`search\`
- **v0.4.0**: \`dead-code\`, \`test-gaps\`, \`impact\``;
	} else {
		featureMsg += `Available commands: \`map\`, \`symbol\`, \`callers\`, \`callees\`, \`context\`, \`search\`

Upgrade to v0.4.0+ for: \`dead-code\`, \`test-gaps\`, \`impact\``;
	}

	// Check index status
	const status = isIndexed(input.cwd);

	if (!status.indexed) {
		return {
			additionalContext: `${featureMsg}

**Not indexed for this project**

Run \`claudemem index\` to enable AST analysis.`,
		};
	}

	// Build cleanup message
	const cleanupMsg =
		cleaned > 0 ? `\n\nCleaned ${cleaned} old session directories` : "";

	return {
		additionalContext: `${featureMsg}

AST index: ${status.symbolCount}${cleanupMsg}

Grep/rg/find intercepted and replaced with AST analysis.`,
	};
}
