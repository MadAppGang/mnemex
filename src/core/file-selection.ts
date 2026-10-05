/**
 * The file-selection predicate (step 3, R3): would `Indexer.discoverFiles`
 * select this path?
 *
 * The dirty overlay's candidates come from git, which lists paths across the
 * WHOLE worktree, and from its own bookkeeping. The index's universe is
 * narrower: `discoverFiles` walks from the PROJECT's real path (which may be a
 * subdirectory of the worktree), matches include/exclude patterns against the
 * PROJECT-relative path, never descends into an excluded directory, and never
 * follows a symlink (a symlink `Dirent` is neither a file nor a directory). A
 * candidate outside that universe is something the index can never hold, so
 * the overlay must neither serve it nor suppress for it.
 *
 * This answers the walk's question for ONE path without walking:
 *
 *   1. inside the worktree (`pathRoot`), and inside the project subtree;
 *   2. no ancestor directory is excluded (as a DIRECTORY, the walk's
 *      `shouldExclude(rel, true, …)`), and every ancestor that exists is a
 *      real directory rather than a symlink to one;
 *   3. the path itself is not excluded, matches an include pattern when there
 *      are any, and has a parser-supported extension;
 *   4. when it exists, it is a regular FILE by `lstat` (a symlink git lists is
 *      not selected). When it does NOT exist — a deletion — rules 1-3 alone
 *      decide, because a deleted file's index rows still have to be hidden.
 *
 * Pinned against `discoverFiles` itself by `overlay-file-selection.test.ts`
 * (F-1): the two must select exactly the same set.
 */

import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getParserManager } from "../parsers/parser-manager.js";
import {
	shouldExclude as sharedShouldExclude,
	shouldInclude as sharedShouldInclude,
} from "../shared/pattern-matcher.js";

export interface FileSelection {
	/** The project's real path: what `discoverFiles` walks from. */
	readonly projectRealPath: string;
	/** The worktree root every stored path is relative to. */
	readonly pathRoot: string;
	/** The indexer's exclude patterns, verbatim (defaults, config, gitignore). */
	readonly excludePatterns: readonly string[];
	/** The indexer's include patterns, verbatim; empty means "everything". */
	readonly includePatterns: readonly string[];
	/** Lower-case extensions with the dot, as the walk compares them. */
	readonly supportedExtensions: ReadonlySet<string>;
}

/**
 * A selection from the indexer's own pattern lists. The caller passes the
 * lists it already resolved (`Indexer`'s `excludePatterns`/`includePatterns`),
 * so this module reads no config and two copies of the precedence cannot
 * drift.
 */
export function createFileSelection(input: {
	projectRealPath: string;
	pathRoot: string;
	excludePatterns: readonly string[];
	includePatterns: readonly string[];
	supportedExtensions?: Iterable<string>;
}): FileSelection {
	return {
		projectRealPath: input.projectRealPath,
		pathRoot: input.pathRoot,
		excludePatterns: [...input.excludePatterns],
		includePatterns: [...input.includePatterns],
		supportedExtensions: new Set(
			input.supportedExtensions ?? getParserManager().getSupportedExtensions(),
		),
	};
}

type EntryKind = "file" | "directory" | "other" | "absent";

function entryKind(path: string): EntryKind {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "other";
		if (stat.isFile()) return "file";
		if (stat.isDirectory()) return "directory";
		return "other";
	} catch {
		return "absent";
	}
}

/** The walk's extension rule: the text after the LAST dot, lower-cased. */
function extensionOf(name: string): string {
	return `.${name.split(".").pop()?.toLowerCase()}`;
}

/**
 * Would `discoverFiles(selection.projectRealPath)` select this worktree-root-
 * relative path? `/`-separated, as git and the tracker spell it.
 */
export function isSelectedFile(
	selection: FileSelection,
	pathRootRelative: string,
): boolean {
	if (pathRootRelative.length === 0 || isAbsolute(pathRootRelative)) {
		return false;
	}
	const absolute = join(selection.pathRoot, pathRootRelative);
	const inWorktree = relative(selection.pathRoot, absolute);
	if (
		inWorktree.length === 0 ||
		inWorktree === ".." ||
		inWorktree.startsWith(`..${sep}`) ||
		isAbsolute(inWorktree)
	) {
		return false;
	}

	// Rule 1: the project subtree. `relative` is the walk's own spelling.
	const projectRel = relative(selection.projectRealPath, absolute);
	if (
		projectRel.length === 0 ||
		projectRel === ".." ||
		projectRel.startsWith(`..${sep}`) ||
		isAbsolute(projectRel)
	) {
		return false;
	}

	const segments = projectRel.split(sep);
	const exclude = selection.excludePatterns as string[];

	// Rule 2: every ancestor directory, as the walk meets it on the way down.
	let ancestor = "";
	for (let i = 0; i < segments.length - 1; i++) {
		ancestor =
			ancestor.length === 0 ? segments[i] : `${ancestor}/${segments[i]}`;
		if (sharedShouldExclude(ancestor, true, exclude)) return false;
		const kind = entryKind(join(selection.projectRealPath, ancestor));
		// An existing ancestor must be a real directory: the walk does not
		// descend through a symlink. An absent one is a deleted directory.
		if (kind !== "directory" && kind !== "absent") return false;
	}

	// Rule 3: the path itself.
	const rel = segments.join("/");
	if (sharedShouldExclude(rel, false, exclude)) return false;
	if (
		selection.includePatterns.length > 0 &&
		!sharedShouldInclude(rel, selection.includePatterns as string[])
	) {
		return false;
	}
	const name = segments[segments.length - 1];
	if (!selection.supportedExtensions.has(extensionOf(name))) return false;

	// Rule 4: a regular file, or absent (a deletion). A symlink is neither.
	const kind = entryKind(absolute);
	return kind === "file" || kind === "absent";
}
