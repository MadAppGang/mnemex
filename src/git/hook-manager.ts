/**
 * Git Hook Manager
 *
 * Manages installation and removal of git hooks for auto-indexing.
 * Supports post-commit hook that runs mnemex index after each commit.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface HookStatus {
	installed: boolean;
	hookType?: "post-commit";
	path?: string;
	isClaudemem?: boolean;
}

// ============================================================================
// Hook Template
// ============================================================================

const HOOK_MARKER = "# mnemex-auto-index";

const POST_COMMIT_HOOK = `#!/bin/sh
${HOOK_MARKER}
# Auto-index changed files after each commit
# Installed by: mnemex hooks install

# Run in background to not block git
(
  if command -v mnemex >/dev/null 2>&1; then
    mnemex index --quiet 2>&1 | logger -t mnemex-hook || true
  fi
) &
`;

// ============================================================================
// Git Hook Manager Class
// ============================================================================

export class GitHookManager {
	private projectPath: string;
	private gitDir: string;
	private hooksDir: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		this.gitDir = join(projectPath, ".git");
		this.hooksDir = join(this.gitDir, "hooks");
	}

	/**
	 * Install the post-commit hook
	 */
	async install(): Promise<void> {
		// Check if .git directory exists
		if (!existsSync(this.gitDir)) {
			throw new Error(
				"Not a git repository. Run 'git init' first or navigate to a git repository.",
			);
		}

		// Ensure hooks directory exists
		if (!existsSync(this.hooksDir)) {
			mkdirSync(this.hooksDir, { recursive: true });
		}

		const hookPath = join(this.hooksDir, "post-commit");

		// Check if hook already exists
		if (existsSync(hookPath)) {
			const existingContent = readFileSync(hookPath, "utf-8");

			// If it's our hook, update it
			if (existingContent.includes(HOOK_MARKER)) {
				writeFileSync(hookPath, POST_COMMIT_HOOK, { mode: 0o755 });
				return;
			}

			// If it's a different hook, append our script
			const newContent = existingContent + "\n\n" + POST_COMMIT_HOOK;
			writeFileSync(hookPath, newContent, { mode: 0o755 });
			return;
		}

		// Create new hook
		writeFileSync(hookPath, POST_COMMIT_HOOK, { mode: 0o755 });
		chmodSync(hookPath, 0o755);
	}

	/**
	 * Uninstall the post-commit hook
	 */
	async uninstall(): Promise<void> {
		const hookPath = join(this.hooksDir, "post-commit");

		if (!existsSync(hookPath)) {
			return; // Nothing to uninstall
		}

		const content = readFileSync(hookPath, "utf-8");

		// If it's only our hook, remove the file
		if (content.includes(HOOK_MARKER)) {
			// Check if there's other content besides our hook
			const lines = content.split("\n");
			const ourHookStart = lines.findIndex((l) => l.includes(HOOK_MARKER));

			if (ourHookStart === 1) {
				// Our hook is the only content (after shebang), remove file
				unlinkSync(hookPath);
				return;
			}

			// Remove only our section
			const newLines: string[] = [];
			let inOurSection = false;

			for (const line of lines) {
				if (line.includes(HOOK_MARKER)) {
					inOurSection = true;
					continue;
				}

				if (inOurSection) {
					// Skip until we hit a blank line followed by non-mnemex content
					if (
						line.trim() === "" ||
						line.startsWith("# ") ||
						line.includes("mnemex")
					) {
						continue;
					}
					inOurSection = false;
				}

				if (!inOurSection) {
					newLines.push(line);
				}
			}

			const newContent = newLines.join("\n").trim();
			if (newContent === "#!/bin/sh" || newContent === "") {
				unlinkSync(hookPath);
			} else {
				writeFileSync(hookPath, newContent + "\n", { mode: 0o755 });
			}
		}
	}

	/**
	 * Check if hook is installed
	 */
	async status(): Promise<HookStatus> {
		const hookPath = join(this.hooksDir, "post-commit");

		if (!existsSync(hookPath)) {
			return { installed: false };
		}

		const content = readFileSync(hookPath, "utf-8");
		const isClaudemem = content.includes(HOOK_MARKER);

		return {
			installed: isClaudemem,
			hookType: isClaudemem ? "post-commit" : undefined,
			path: hookPath,
			isClaudemem,
		};
	}

	/**
	 * Check if we're in a git repository
	 */
	isGitRepository(): boolean {
		return existsSync(this.gitDir);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a git hook manager instance
 */
export function createGitHookManager(projectPath: string): GitHookManager {
	return new GitHookManager(projectPath);
}
