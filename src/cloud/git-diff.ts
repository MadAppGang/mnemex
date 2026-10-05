/**
 * GitDiffChangeDetector
 *
 * Implements IChangeDetector by running git subprocesses.
 * Used to compute which files changed between commits, and which
 * local files are dirty (uncommitted), for incremental cloud indexing.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile, DirtyFile, IChangeDetector } from "./types.js";

// ============================================================================
// Worktree status — the dirty overlay's listing (step 3, R3)
// ============================================================================

/**
 * `git status` for the local dirty overlay. A NEW listing, deliberately apart
 * from `getDirtyFiles`/`parsePorcelain` (cloud-only, unchanged):
 *
 *   --no-optional-locks   `git status` otherwise REFRESHES `.git/index` when
 *                         stat data moved (measured on git 2.56.0: after a
 *                         `touch`, the index mtime moved). This runs on every
 *                         search, so without it mnemex would take `index.lock`
 *                         against the user's own commit/add/rebase.
 *   --porcelain=v1 -z     stable, and NUL-separated: no path is quoted or
 *                         octal-escaped (spaces, non-ASCII, newlines).
 *   -uall                 an untracked DIRECTORY lists its files.
 *   --no-renames          a rename is a deletion plus an addition: the old
 *                         path's index rows must be hidden AND the new one
 *                         served, so both paths are needed.
 *   --ignore-submodules=all  a submodule's own changes are not this tree's files.
 *
 * Paths are relative to the repository root (porcelain ignores
 * `status.relativePaths`).
 */
export const WORKTREE_STATUS_ARGS = [
	"--no-optional-locks",
	"status",
	"--porcelain=v1",
	"-z",
	"-uall",
	"--no-renames",
	"--ignore-submodules=all",
] as const;

/** An overflowing listing is `too-large`, never an unbounded buffer. */
export const WORKTREE_STATUS_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The child environment: `base` with EVERY `GIT_*` removed — so an inherited
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (a search run from a git hook)
 * cannot point this at another repository — and then `GIT_OPTIONAL_LOCKS=0`
 * and `GIT_PAGER=cat` set explicitly. Stripping `GIT_*` would otherwise also
 * remove a caller's own `GIT_OPTIONAL_LOCKS`, which is why it is re-added.
 */
export function worktreeStatusEnv(
	base: NodeJS.ProcessEnv,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_PAGER = "cat";
	return env;
}

/** One porcelain-v1 record: the two status letters and the path, verbatim. */
export interface WorktreeStatusEntry {
	/** Repository-root-relative, `/`-separated, exactly as git wrote it. */
	readonly path: string;
	/** `X`: the index (staged) status. `?` for untracked. */
	readonly index: string;
	/** `Y`: the working-tree status. `?` for untracked. */
	readonly worktree: string;
}

export type WorktreeStatusResult =
	| { readonly ok: true; readonly entries: readonly WorktreeStatusEntry[] }
	| {
			readonly ok: false;
			readonly reason: "no-git" | "git-failed" | "too-large";
			readonly message: string;
	  };

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Records are NUL-terminated `XY PATH`. A rename/copy record (`R`/`C` in
 * either column) is followed by one more NUL-terminated field, the ORIGINAL
 * path; `--no-renames` means it should not occur, but a parser that ignored it
 * would read the original path as a new record, so it is consumed and reported
 * as a deletion of the original. A path ending in `/` is a directory (an
 * untracked nested repository) and is not a file: skipped.
 */
export function parsePorcelainZ(output: string): WorktreeStatusEntry[] {
	const fields = output.split("\0");
	const entries: WorktreeStatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (record.length < 4) continue;
		const index = record[0];
		const worktree = record[1];
		const path = record.slice(3);
		const renamed =
			index === "R" || index === "C" || worktree === "R" || worktree === "C";
		if (!path.endsWith("/")) entries.push({ path, index, worktree });
		if (renamed) {
			i++;
			const original = fields[i];
			if (original !== undefined && original.length > 0) {
				entries.push({ path: original, index: "D", worktree: " " });
			}
		}
	}
	return entries;
}

/** What a failed `execFile` says about itself, read without trusting its shape. */
function failureOf(error: unknown, timeoutMs?: number): WorktreeStatusResult {
	const err = error as {
		code?: unknown;
		killed?: unknown;
		message?: unknown;
		stderr?: unknown;
	};
	const message =
		typeof err.stderr === "string" && err.stderr.trim().length > 0
			? err.stderr.trim()
			: typeof err.message === "string"
				? err.message
				: String(error);
	if (
		err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
		/maxBuffer/i.test(message)
	) {
		return { ok: false, reason: "too-large", message };
	}
	// Killed by `execFile`'s own `timeout` (code review 2, MEDIUM 4). After
	// the maxBuffer test: an overflow kills the child too.
	if (timeoutMs !== undefined && err.killed === true) {
		return {
			ok: false,
			reason: "git-failed",
			message: `git status timed out after ${timeoutMs} ms`,
		};
	}
	if (err.code === "ENOENT") {
		return { ok: false, reason: "no-git", message: "git is not installed" };
	}
	if (/not a git repository/i.test(message)) {
		return { ok: false, reason: "no-git", message };
	}
	return { ok: false, reason: "git-failed", message };
}

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
	 * The working tree's dirty listing for the LOCAL dirty overlay (step 3).
	 * See `WORKTREE_STATUS_ARGS` for every flag and why. `execFile`, no shell;
	 * `cwd` is this detector's project path; env from `worktreeStatusEnv`.
	 *
	 * NEVER throws: no git / not a repository → `no-git`, an overflowing
	 * listing → `too-large`, anything else → `git-failed`, each with git's own
	 * message. With `timeoutMs`, a git still running then is killed and the
	 * result is `git-failed` "timed out" — a wedged git (a hung filesystem, a
	 * stuck credential helper) no longer holds the caller for ever.
	 */
	async getWorktreeStatus(
		options: { maxBuffer?: number; timeoutMs?: number } = {},
	): Promise<WorktreeStatusResult> {
		// Resolved through the live import binding on every call, for the same
		// reason `run()` does it (a module mock must stay effective).
		const execFileAsync = promisify(execFile);
		try {
			const { stdout } = await execFileAsync("git", [...WORKTREE_STATUS_ARGS], {
				cwd: this.projectPath,
				env: worktreeStatusEnv(process.env),
				maxBuffer: options.maxBuffer ?? WORKTREE_STATUS_MAX_BUFFER,
				encoding: "utf8",
				...(options.timeoutMs !== undefined && options.timeoutMs > 0
					? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }
					: {}),
			});
			return { ok: true, entries: parsePorcelainZ(String(stdout)) };
		} catch (error) {
			return failureOf(error, options.timeoutMs);
		}
	}

	/**
	 * Get the current HEAD commit SHA (full 40-char hex string).
	 */
	async getHeadSha(): Promise<string> {
		const output = await this.run("git rev-parse HEAD");
		return output.trim();
	}

	/**
	 * Get the first-parent depth of a commit — its ordinal.
	 *
	 * SHAs are not orderable, so anything that needs `argmax(recency)` needs a
	 * number. `git rev-list --count --first-parent <sha>` counts commits on the
	 * first-parent chain, which is monotonic along a linear history and ignores
	 * the internals of merged side branches.
	 *
	 * NOT stable across history rewrites: rebase, amend, filter-branch and
	 * squash-merge all renumber commits. Anything persisted against an ordinal
	 * must be rebuilt (reindexed) after a rewrite.
	 */
	async getCommitOrdinal(commitSha: string): Promise<number> {
		const output = await this.run(
			`git rev-list --count --first-parent ${commitSha}`,
		);
		const ordinal = Number.parseInt(output.trim(), 10);
		if (!Number.isFinite(ordinal)) {
			throw new Error(`Unparseable rev-list count: ${JSON.stringify(output)}`);
		}
		return ordinal;
	}

	/**
	 * Get the committer date of a commit as a strict ISO-8601 string.
	 */
	async getCommitTimestamp(commitSha: string): Promise<string> {
		const output = await this.run(`git show -s --format=%cI ${commitSha}`);
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

	/**
	 * Run a git command in the project directory and return stdout.
	 *
	 * `exec` is resolved through the live import binding on every call rather
	 * than snapshotted into a module-level `promisify(exec)`. Snapshotting made
	 * the mock in test/unit/cloud/git-diff.test.ts silently ineffective as soon
	 * as anything else imported this module first, which turned real coverage
	 * into 23 spurious ENOENT failures that depended on test file ordering.
	 */
	private async run(cmd: string): Promise<string> {
		const execAsync = promisify(exec);
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
