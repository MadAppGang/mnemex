/**
 * The stored-path convention (architecture §3.1).
 *
 * A stored `filePath` is POSIX, relative to `pathRoot` (the worktree root, or
 * the start path outside a repository), with no leading `./` and no `..`
 * segment. Search OUTPUT stays absolute (decision D4).
 *
 * `toRepoRelative` and `fromStoredPath` are INVERSES, declared next to each
 * other on purpose. A change to one is a change to both.
 *
 * WHERE THEY ARE CALLED is the contract:
 *   - `fromStoredPath` is called only by `src/core/store.ts`, at the row →
 *     result hydration every read passes through. Nothing above the store
 *     converts a path.
 *   - `toRepoRelative` runs wherever a stored path is PRODUCED (the indexer,
 *     before chunking, so the chunk id hashes the stored path) or COMPARED (the
 *     tracker, and the store's path arguments).
 *
 * §3.1 places both functions in store.ts. They live in this leaf module instead
 * so the tracker can import `toRepoRelative` without importing LanceDB; the
 * one-read-seam rule is about the call site, and that is unchanged.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * `"repo"`: a real path under `pathRoot`, returned absolute by the read seam.
 * `"synthetic"`: anything that is not a path under `pathRoot` (a `docs:<pkg>`
 * id, a session observation, a scratch store's rows), returned exactly as
 * stored. Structural, not lexical: nothing decides this from the string.
 */
export type PathKind = "repo" | "synthetic";

/** Longest path this module will walk up while canonicalising, in segments. */
const MAX_CANONICAL_WALK = 256;

/**
 * `absPath` as a stored path under `pathRoot`, or `null` when it is not under
 * it: a `..` segment, a different drive, `pathRoot` itself, or a relative
 * input. A `null` is a REJECTION, never a constraint to work around. The
 * indexer skips such a file and reports it as `outside-path-root`.
 *
 * Lexical first. When that escapes, the path is retried in realpath spelling:
 * `pathRoot` comes from the seam, which realpaths it (decision I-3), so a
 * caller's `/tmp/x/a.ts` against a root of `/private/tmp/x` is the same file
 * under two spellings, not a file outside the tree. The fallback costs one
 * `realpath` and runs only on the mismatch path.
 */
export function toRepoRelative(
	pathRoot: string,
	absPath: string,
): string | null {
	const direct = lexicalRelative(pathRoot, absPath);
	if (direct !== null) return direct;
	const canonical = canonicalAbsolute(absPath);
	if (canonical === null || canonical === absPath) return null;
	return lexicalRelative(pathRoot, canonical);
}

/**
 * A stored row's path as a caller sees it: absolute for `pathKind === "repo"`,
 * untouched for everything else (including rows written before index version
 * 4, which carry no `pathKind` and were stored absolute).
 */
export function fromStoredPath(
	pathRoot: string,
	row: { readonly filePath: string; readonly pathKind?: unknown },
): string {
	return row.pathKind === "repo" ? join(pathRoot, row.filePath) : row.filePath;
}

/** True when `path` obeys the stored-path convention for a `"repo"` row. */
export function isStoredRepoPath(path: string): boolean {
	if (path === "" || isAbsolute(path)) return false;
	return !path.split("/").includes("..");
}

function lexicalRelative(root: string, absPath: string): string | null {
	if (!isAbsolute(absPath)) return null;
	const rel = relative(root, absPath);
	if (rel === "" || isAbsolute(rel)) return null;
	const posix = sep === "/" ? rel : rel.split(sep).join("/");
	return posix.split("/").includes("..") ? null : posix;
}

/**
 * `absPath` with its longest existing prefix realpath'd, or null. The file
 * itself need not exist (a deleted file's path is still converted), so this
 * walks up to the nearest ancestor that does.
 */
function canonicalAbsolute(absPath: string): string | null {
	if (!isAbsolute(absPath)) return null;
	const tail: string[] = [];
	let current = absPath;
	for (let step = 0; step < MAX_CANONICAL_WALK; step++) {
		try {
			const real = realpathSync.native(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			tail.push(basename(current));
			current = parent;
		}
	}
	return null;
}
