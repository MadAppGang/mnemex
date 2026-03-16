/**
 * GitDiffChangeDetector
 *
 * Implements IChangeDetector by running git subprocesses.
 * Used to compute which files changed between commits, and which
 * local files are dirty (uncommitted), for incremental cloud indexing.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile, DirtyFile, IChangeDetector } from "./types.js";

const execAsync = promisify(exec);

// ============================================================================
// GitDiffChangeDetector
// ============================================================================

/**
 * Detects file changes using git subprocess calls.
 * All paths returned are relative to the project root.
 */
export class GitDiffChangeDetector implements IChangeDetector {
	private readonly projectPath: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
	}

	// --------------------------------------------------------------------------
	// IChangeDetector implementation
	// --------------------------------------------------------------------------

	/**
	 * Get files changed between two commits.
	 * Pass null for fromSha to diff from the very first commit (initial commit).
	 *
	 * Uses `git diff --name-status` for normal diffs and
	 * `git diff-tree --root` for the initial commit.
	 */
	async getChangedFiles(
		fromSha: string | null,
		toSha: string,
	): Promise<ChangedFile[]> {
		let output: string;

		if (fromSha === null) {
			// Initial commit — diff against the empty tree
			const result = await this.run(
				`git diff-tree --root --name-status -r ${toSha}`,
			);
			output = result;
		} else {
			const result = await this.run(
				`git diff --name-status ${fromSha}..${toSha}`,
			);
			output = result;
		}

		return this.parseNameStatus(output);
	}

	/**
	 * Get files with uncommitted local changes.
	 * Includes both tracked modifications and untracked files.
	 *
	 * Uses `git status --porcelain` which is stable across git versions.
	 */
	async getDirtyFiles(): Promise<DirtyFile[]> {
		const output = await this.run("git status --porcelain");
		return this.parsePorcelain(output);
	}

	/**
	 * Get the current HEAD commit SHA (full 40-char hex string).
	 */
	async getHeadSha(): Promise<string> {
		const output = await this.run("git rev-parse HEAD");
		return output.trim();
	}

	/**
	 * Get parent commit SHA(s) for the given commit.
	 * Merge commits will have two or more parents.
	 * The initial commit will have no parents — returns [].
	 *
	 * Uses `git rev-parse <sha>^@` which expands to all parents.
	 */
	async getParentShas(commitSha: string): Promise<string[]> {
		try {
			// `^@` expands to all parent refs; `--` prevents ambiguity
			const output = await this.run(`git rev-parse ${commitSha}^@`);
			return output
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s.length === 40);
		} catch {
			// The initial commit has no parents — git exits non-zero
			return [];
		}
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------

	/** Run a git command in the project directory and return stdout */
	private async run(cmd: string): Promise<string> {
		const { stdout } = await execAsync(cmd, {
			cwd: this.projectPath,
			// Prevent git from spawning a pager
			env: { ...process.env, GIT_PAGER: "cat" },
		});
		return stdout;
	}

	/**
	 * Parse `git diff --name-status` / `git diff-tree --root --name-status` output.
	 *
	 * Format per line:
	 *   M  path/to/file
	 *   A  path/to/new-file
	 *   D  path/to/deleted-file
	 *   R100  old/path  new/path   (rename with similarity score)
	 */
	private parseNameStatus(output: string): ChangedFile[] {
		const results: ChangedFile[] = [];

		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			// Rename lines: "R100\told/path\tnew/path"
			if (trimmed.startsWith("R")) {
				const parts = trimmed.split("\t");
				if (parts.length >= 3) {
					results.push({
						filePath: parts[2],
						status: "renamed",
						oldPath: parts[1],
					});
				}
				continue;
			}

			// Normal status lines: "M\tpath" or "A\tpath" or "D\tpath"
			const tabIdx = trimmed.indexOf("\t");
			if (tabIdx === -1) continue;

			const statusChar = trimmed.slice(0, tabIdx).trim();
			const filePath = trimmed.slice(tabIdx + 1).trim();

			if (!filePath) continue;

			switch (statusChar) {
				case "A":
					results.push({ filePath, status: "added" });
					break;
				case "M":
					results.push({ filePath, status: "modified" });
					break;
				case "D":
					results.push({ filePath, status: "deleted" });
					break;
				// Copy ("C") — treat as added at the new path
				default:
					if (statusChar.startsWith("C")) {
						const parts = trimmed.split("\t");
						if (parts.length >= 3) {
							results.push({ filePath: parts[2], status: "added" });
						}
					}
					break;
			}
		}

		return results;
	}

	/**
	 * Parse `git status --porcelain` output.
	 *
	 * Porcelain format (two-char status code + space + path):
	 *   " M path"  — modified in working tree (tracked)
	 *   "M  path"  — modified in index (staged)
	 *   "MM path"  — modified in both
	 *   "A  path"  — added to index
	 *   " A path"  — added in working tree (shouldn't happen; treated as untracked)
	 *   "D  path"  — deleted from index
	 *   " D path"  — deleted from working tree
	 *   "?? path"  — untracked
	 *   "R  old -> new" — renamed (index)
	 */
	private parsePorcelain(output: string): DirtyFile[] {
		const results: DirtyFile[] = [];

		for (const line of output.split("\n")) {
			if (line.length < 4) continue;

			const indexStatus = line[0];
			const workStatus = line[1];
			// Path starts after "XY " (3 chars)
			const rawPath = line.slice(3);

			// Untracked
			if (indexStatus === "?" && workStatus === "?") {
				results.push({ filePath: rawPath, status: "untracked" });
				continue;
			}

			// Renamed in index — "R  old\x00new" in v1, or "R  old -> new"
			// Porcelain v1 uses " -> " separator for renames
			if (indexStatus === "R" || workStatus === "R") {
				const arrowIdx = rawPath.indexOf(" -> ");
				const newPath = arrowIdx !== -1 ? rawPath.slice(arrowIdx + 4) : rawPath;
				results.push({ filePath: newPath, status: "modified" });
				continue;
			}

			// Deleted
			if (indexStatus === "D" || workStatus === "D") {
				results.push({ filePath: rawPath, status: "deleted" });
				continue;
			}

			// Added (staged)
			if (indexStatus === "A") {
				results.push({ filePath: rawPath, status: "added" });
				continue;
			}

			// Modified (staged or working tree)
			if (indexStatus === "M" || workStatus === "M") {
				results.push({ filePath: rawPath, status: "modified" });
				continue;
			}
		}

		return results;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a GitDiffChangeDetector for the given project path.
 */
export function createGitDiffChangeDetector(
	projectPath: string,
): GitDiffChangeDetector {
	return new GitDiffChangeDetector(projectPath);
}
