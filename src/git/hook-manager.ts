/**
 * Git Hook Manager
 *
 * Manages installation and removal of git hooks for auto-indexing.
 * Supports post-commit hook that runs mnemex index after each commit.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	graphBranchIdForRead,
	resolveBranchScopeForProject,
} from "../core/branch-scope.js";
import { readGitLayout } from "../core/git-layout.js";
import {
	formatInvalidationCounts,
	type InvalidationCounts,
	invalidateForCommit,
} from "../core/invalidation.js";
import type { IFileTracker } from "../core/tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface HookStatus {
	installed: boolean;
	hookType?: "post-commit";
	path?: string;
	isMnemex?: boolean;
}

/** Outcome of the invalidation pass a commit triggers */
export interface PostCommitInvalidation {
	counts: InvalidationCounts;
	/** Human-readable one-liner for logs */
	summary: string;
}

// ============================================================================
// Hook Template
// ============================================================================

const HOOK_MARKER = "# mnemex-auto-index";

const POST_COMMIT_HOOK = `#!/bin/sh
${HOOK_MARKER}
# Auto-index changed files after each commit, and invalidate the memories this
# commit made wrong. The invalidation runs inside the index pass (see
# src/core/invalidation.ts) so the hook stays a single command and a git
# failure can never block the commit.
# Installed by: mnemex hooks install

# Run in background to not block git
(
  if command -v mnemex >/dev/null 2>&1; then
    mnemex index --quiet 2>&1 | logger -t mnemex-hook || true
  fi
) &
`;

// ============================================================================
// Hook Location
// ============================================================================

interface HookDirs {
	/** This checkout's own git dir. Its existence is what "a git repository" means to install(). */
	gitDir: string;
	/** Where git reads this checkout's hooks from. */
	hooksDir: string;
}

/**
 * Git keeps hooks in `<gitCommonDir>/hooks` for EVERY worktree of a repository.
 * In a linked worktree `<projectPath>/.git` is a FILE (`gitdir: <path>`), so the
 * old `<projectPath>/.git/hooks` pointed inside a file: install failed with
 * ENOTDIR and status reported "not installed". Because the directory is shared,
 * install, uninstall and status act on ONE hook whichever worktree runs them.
 *
 * The gate is unchanged: the layout is used only when `<projectPath>/.git`
 * exists, which is today's test. `readGitLayout` inspects the start directory's
 * `.git` first, so a layout found from there is rooted at `projectPath`. Every
 * other case keeps today's `<projectPath>/.git` exactly:
 *   - no repository, or a degraded one (`layout: null`, e.g. a pruned worktree's
 *     dangling `.git` file) — `readGitLayout` never throws;
 *   - a subdirectory of a checkout — git runs the hook from the worktree root,
 *     so a hook installed on a subdirectory's behalf would index the whole
 *     checkout instead of the project that asked;
 *   - a bare repository — it has no `.git` entry and no commit is made in one.
 *
 * `core.hooksPath` is not honoured, as before.
 */
function resolveHookDirs(projectPath: string): HookDirs {
	const dotGit = join(projectPath, ".git");
	if (existsSync(dotGit)) {
		const { layout } = readGitLayout(projectPath);
		if (layout !== null) {
			return {
				gitDir: layout.gitDir,
				hooksDir: join(layout.gitCommonDir, "hooks"),
			};
		}
	}
	return { gitDir: dotGit, hooksDir: join(dotGit, "hooks") };
}

// ============================================================================
// Git Hook Manager Class
// ============================================================================

export class GitHookManager {
	private projectPath: string;
	private gitDir: string;
	private hooksDir: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		const { gitDir, hooksDir } = resolveHookDirs(projectPath);
		this.gitDir = gitDir;
		this.hooksDir = hooksDir;
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
			const newContent = `${existingContent}\n\n${POST_COMMIT_HOOK}`;
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
				writeFileSync(hookPath, `${newContent}\n`, { mode: 0o755 });
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
		const isMnemex = content.includes(HOOK_MARKER);

		return {
			installed: isMnemex,
			hookType: isMnemex ? "post-commit" : undefined,
			path: hookPath,
			isMnemex,
		};
	}

	/**
	 * Check if we're in a git repository
	 */
	isGitRepository(): boolean {
		return existsSync(this.gitDir);
	}

	/**
	 * Walk the diff of the commit that just landed and invalidate against it.
	 *
	 * See `runPostCommitInvalidation` — this is the instance-shaped entry point
	 * for callers that already hold a hook manager.
	 */
	async runInvalidation(
		tracker: IFileTracker,
	): Promise<PostCommitInvalidation | null> {
		return runPostCommitInvalidation(this.projectPath, tracker);
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

// ============================================================================
// Post-Commit Invalidation
// ============================================================================

/**
 * The work the post-commit path performs beyond re-indexing: walk the commit's
 * own diff once, then apply the three-class invalidation policy to it.
 *
 * Returns null — having changed nothing and thrown nothing — when the directory
 * is not a git repository, git is missing, the repository has no commits, or
 * any git call fails. A commit hook that can fail a commit, and an index run
 * that can fail because provenance was unavailable, are both strictly worse
 * than no invalidation.
 *
 * Exactly one `git diff` per commit; never one per file.
 */
export async function runPostCommitInvalidation(
	projectPath: string,
	tracker: IFileTracker,
): Promise<PostCommitInvalidation | null> {
	try {
		// The branch HEAD points at, resolved per call. The hook runs after a
		// commit, and that commit may be the first on a branch the index has
		// never seen — `graphBranchIdForRead` then yields the shared marker,
		// which matches no `documents` row, so the pass invalidates nothing
		// rather than invalidating another branch's summaries.
		const counts = await invalidateForCommit(
			projectPath,
			tracker,
			graphBranchIdForRead(resolveBranchScopeForProject(projectPath)),
		);
		if (!counts) return null;

		return { counts, summary: formatInvalidationCounts(counts) };
	} catch {
		return null;
	}
}
