/**
 * Where is this checkout's git directory, and where is the repository's?
 *
 * Answers what `git rev-parse --git-dir` / `--git-common-dir` answer, by reading
 * the `.git` entry, `commondir` and `HEAD` with `fs`, and never by running git
 * (architecture §2.1, §2.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SUBPROCESS, EVER (NFR-3, CLAUDE.md #24). Process launch in `src/` is an
 * allowlist, and this file is not on it and must not be. A spawn here would sit
 * on the search path and in hooks, and `Bun.spawnSync` blocks the event loop,
 * which is exactly the failure CLAUDE.md #27 bounds. The cost of not spawning is
 * re-implementing `commondir` resolution. That risk is answered by fixtures for
 * all five `.git` shapes plus an equality test against a real
 * `git rev-parse --git-common-dir` (test/unit/core/git-layout*.test.ts).
 *
 * IMPORT ALLOWLIST: `node:fs`, `node:path`, `node:crypto`, and NOTHING ELSE.
 * `node:crypto` is here only for the sha1 in the unreadable-HEAD label (§3.4,
 * N12). Enforced by test/unit/core/store-location-imports.test.ts.
 *
 * NEVER THROWS. Path resolution must not become a new way for a command to fail
 * (§2.1, the posture `src/migration.ts` established). Every failure degrades to
 * "not a repository", and inside something that looked like one it carries a
 * `degradedReason` string for `IndexResult` and `mnemex doctor`.
 *
 * `GIT_DIR` / `GIT_COMMON_DIR` are deliberately IGNORED (§2.2). Hooks set them,
 * often to the relative string `.git`, and the post-commit hook is one of the
 * index entry points. Walking the filesystem from the start path gives the
 * right answer in a hook.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	openSync,
	readSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * At most this many directories are examined, the start directory included.
 * Bounds the walk (NFR-1): ≤64 `.git` stats and ≤64 `HEAD` stats, however deep
 * the start path.
 */
export const MAX_PARENT_WALK = 64;

/**
 * A `.git` file, `commondir` and `HEAD` are each one short line. Nothing longer
 * than this is read, so a hostile or corrupt file cannot make resolution
 * unbounded. A larger file is treated as invalid, not truncated.
 */
export const GIT_POINTER_FILE_MAX_BYTES = 4096;

export type HeadKind = "branch" | "detached" | "unknown";

export interface GitHead {
	/** "main" for a branch; the 40-hex sha for a detached HEAD; "HEAD@<sha1-12 of gitDir>" when unreadable (§3.4). */
	readonly label: string;
	readonly kind: HeadKind;
	/** "refs/heads/main" when kind === "branch", else null. */
	readonly ref: string | null;
}

export interface GitLayout {
	/** Directory holding the `.git` entry (or the bare repo itself). Absolute, realpath-resolved. */
	readonly worktreeRoot: string;
	/** THIS worktree's git dir. Main: <root>/.git. Linked: <common>/worktrees/<name>. */
	readonly gitDir: string;
	/** The repository-wide git dir. Equals gitDir for a main worktree and for a bare repo. */
	readonly gitCommonDir: string;
	readonly isLinkedWorktree: boolean;
	readonly isBare: boolean;
}

export type GitLayoutResult =
	| { readonly layout: GitLayout }
	| { readonly layout: null; readonly degradedReason: string | null };

const GITFILE_PREFIX = "gitdir:";
const SYMREF_PREFIX = "ref:";
const BRANCH_REF_PREFIX = "refs/heads/";
/** Full sha only: short shas collide over a repository's life, and the label is a registry key (§2.1). */
const FULL_SHA = /^[0-9a-f]{40}$/;
const UNKNOWN_HEAD_HASH_CHARS = 12;

/**
 * The layout of the git checkout containing `startPath`, or a null layout
 * outside a repository. NEVER throws.
 *
 * `degradedReason` is null when nothing git-shaped was found, and a string when
 * something was found but could not be resolved:
 *   - `gitdir-missing:<path>`     the gitdir (or the common dir) is not a directory
 *                                 — a moved or pruned linked worktree
 *   - `gitfile-invalid:<path>`    a `.git` FILE without a `gitdir:` line
 *   - `commondir-invalid:<path>`  a `commondir` file that exists but is empty,
 *                                 unreadable or oversized
 */
export function readGitLayout(startPath: string): GitLayoutResult {
	try {
		return discoverLayout(startPath);
	} catch (error) {
		// Unreachable by construction: every fs call below is individually
		// guarded. This is the backstop that keeps "never throws" true if a
		// later edit adds an unguarded one.
		return {
			layout: null,
			degradedReason: `layout-error:${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Re-read HEAD. Deliberately NOT memoized and deliberately separate from
 * readGitLayout: the MCP server is long-lived and the user switches branches
 * underneath it (§2.5).
 *
 * Reads `<gitDir>/HEAD`, i.e. THIS worktree's HEAD. A linked worktree's HEAD is
 * at `<commonDir>/worktrees/<name>/HEAD`; reading `<commonDir>/HEAD` would give
 * every worktree the main checkout's branch.
 */
export function readCurrentHead(layout: GitLayout): GitHead {
	const line = readFirstLine(join(layout.gitDir, "HEAD"));
	if (line !== null) {
		const value = line.trim();
		if (value.startsWith(SYMREF_PREFIX)) {
			const ref = value.slice(SYMREF_PREFIX.length).trim();
			if (
				ref.startsWith(BRANCH_REF_PREFIX) &&
				ref.length > BRANCH_REF_PREFIX.length
			) {
				return Object.freeze({
					label: ref.slice(BRANCH_REF_PREFIX.length),
					kind: "branch",
					ref,
				});
			}
		} else if (FULL_SHA.test(value)) {
			return Object.freeze({ label: value, kind: "detached", ref: null });
		}
	}
	return Object.freeze({
		label: unknownHeadLabel(layout.gitDir),
		kind: "unknown",
		ref: null,
	});
}

/**
 * `HEAD@<sha1-12 of the resolved gitDir>`: one bucket PER WORKTREE, never a
 * shared `"HEAD"` label (§3.4, N12). A shared label would let two worktrees
 * with unreadable HEADs see each other's rows.
 */
export function unknownHeadLabel(gitDir: string): string {
	const digest = createHash("sha1").update(gitDir).digest("hex");
	return `HEAD@${digest.slice(0, UNKNOWN_HEAD_HASH_CHARS)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Discovery
// ════════════════════════════════════════════════════════════════════════════

function discoverLayout(startPath: string): GitLayoutResult {
	let dir = realpathOr(startPath, resolve(startPath));
	for (let examined = 0; examined < MAX_PARENT_WALK; examined++) {
		const dotGit = join(dir, ".git");
		const entry = statOrNull(dotGit);

		// Main worktree.
		if (entry?.isDirectory()) return layoutFrom(dir, dotGit, false);

		// Linked worktree or submodule: `.git` is a FILE holding `gitdir: <path>`.
		// `existsSync` cannot tell the two apart, which is the defect in
		// `src/git/hook-manager.ts:75-84`.
		if (entry?.isFile()) {
			const target = readGitfileTarget(dotGit);
			if (target === null) {
				return { layout: null, degradedReason: `gitfile-invalid:${dotGit}` };
			}
			return layoutFrom(dir, resolveAgainst(dir, target), false);
		}

		// Bare repository: no `.git` entry, but the directory IS a git dir.
		// Checked before walking on, or a bare repo falls through to the
		// plain-directory fallback, which is wrong for the one shape that IS
		// the common dir.
		if (holdsGitDirectory(dir)) return layoutFrom(dir, dir, true);

		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { layout: null, degradedReason: null };
}

function layoutFrom(
	worktreeRoot: string,
	gitDirPath: string,
	isBare: boolean,
): GitLayoutResult {
	// Validate what was derived. A moved or pruned linked worktree leaves a
	// `.git` file pointing at a gitdir that no longer exists. Without this the
	// caller would create a store under a dead git directory, invisible from
	// the main worktree and deleted by the next `git worktree prune`.
	if (!isDirectory(gitDirPath)) {
		return { layout: null, degradedReason: `gitdir-missing:${gitDirPath}` };
	}

	// `commondir` present: a linked worktree, usually `../..`. Absent: a main
	// worktree, a bare repo or a submodule, whose common dir is its own gitdir.
	let gitCommonDirPath = gitDirPath;
	const commondirFile = join(gitDirPath, "commondir");
	if (statOrNull(commondirFile) !== null) {
		const value = readFirstLine(commondirFile)?.trim() ?? "";
		if (value === "") {
			return {
				layout: null,
				degradedReason: `commondir-invalid:${commondirFile}`,
			};
		}
		gitCommonDirPath = resolveAgainst(gitDirPath, value);
	}
	if (!isDirectory(gitCommonDirPath)) {
		return {
			layout: null,
			degradedReason: `gitdir-missing:${gitCommonDirPath}`,
		};
	}

	// realpath, so `/tmp` vs `/private/tmp` on darwin, or a symlinked checkout,
	// cannot produce two store paths for one repository.
	const gitDir = realpathOr(gitDirPath, gitDirPath);
	const gitCommonDir = realpathOr(gitCommonDirPath, gitCommonDirPath);
	return {
		layout: Object.freeze({
			worktreeRoot: realpathOr(worktreeRoot, worktreeRoot),
			gitDir,
			gitCommonDir,
			isLinkedWorktree: !isBare && gitDir !== gitCommonDir,
			isBare,
		}),
	};
}

/** The `gitdir:` value of a `.git` file, trimmed, or null if the file is not one. */
function readGitfileTarget(path: string): string | null {
	const line = readFirstLine(path);
	if (line === null || !line.startsWith(GITFILE_PREFIX)) return null;
	// Trimmed: a trailing newline (`\n` or `\r\n`) is always written, and an
	// untrimmed value breaks path resolution on a Windows checkout.
	const value = line.slice(GITFILE_PREFIX.length).trim();
	return value === "" ? null : value;
}

/** HEAD, objects/ and refs/ together: the minimum that makes a directory a git dir. */
function holdsGitDirectory(dir: string): boolean {
	// HEAD first: almost no directory has one, so the other two stats are rare.
	return (
		statOrNull(join(dir, "HEAD"))?.isFile() === true &&
		isDirectory(join(dir, "objects")) &&
		isDirectory(join(dir, "refs"))
	);
}

// ════════════════════════════════════════════════════════════════════════════
// Guarded fs primitives. Each returns a sentinel instead of throwing.
// ════════════════════════════════════════════════════════════════════════════

/**
 * `path.isAbsolute`, never `startsWith("/")`: the latter classifies `C:\…` as
 * relative and joins it (the pre-existing defect at `src/config.ts` getIndexDir).
 */
function resolveAgainst(base: string, value: string): string {
	return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function isDirectory(path: string): boolean {
	return statOrNull(path)?.isDirectory() === true;
}

/** `realpathSync.native` (the canonical case on a case-insensitive volume), or `fallback`. */
function realpathOr(path: string, fallback: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return fallback;
	}
}

/**
 * The first line of a small file, without its line terminator, or null if the
 * file cannot be read or exceeds {@link GIT_POINTER_FILE_MAX_BYTES}.
 *
 * Bounded by construction: reads at most one byte past the cap, so the size
 * check cannot be raced by a file that grows between a stat and a read.
 */
function readFirstLine(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(GIT_POINTER_FILE_MAX_BYTES + 1);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead > GIT_POINTER_FILE_MAX_BYTES) return null;
		const text = buffer.toString("utf8", 0, bytesRead);
		return text.split(/\r?\n/, 1)[0] ?? "";
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Nothing to do: the read already succeeded or already failed.
			}
		}
	}
}
