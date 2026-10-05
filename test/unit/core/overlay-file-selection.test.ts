/**
 * F-1 (step 3, R3) — the dirty overlay's file universe IS the indexer's.
 *
 * The overlay is fed by git, which lists paths across the WHOLE worktree; the
 * indexer walks only the project's real path and matches patterns relative to
 * it (`Indexer.discoverFiles`). If the two universes differ, the overlay either
 * serves a file the index would never hold (a `.mnemex/` sidecar, a vendored
 * file, something outside a subdirectory project) or suppresses nothing for a
 * file it should have covered. So the property is an EQUALITY of sets:
 *
 *     discoverFiles(projectRealPath)  ==  { every file under pathRoot } ∩ isSelectedFile
 *
 * computed over a tree built to contain every shape that can tell them apart:
 * a project that is a SUBDIRECTORY of the worktree, files outside it, an
 * excluded directory, an excluded file pattern, ALWAYS_EXCLUDE_DIRS
 * (`node_modules`, `.mnemex`), an unsupported extension, a symlinked FILE and a
 * symlinked DIRECTORY (the walk follows neither), and include patterns.
 *
 * `discoverFiles` is private and its constructor reads the user's global
 * config; it is reached through the prototype with the two fields it reads set
 * directly, so this test never touches `~/.mnemex`.
 *
 * FALSIFIED BY: dropping the ancestor-directory check, the project-subtree
 * check, or the `lstat` (symlink) check from `isSelectedFile`; each makes the
 * sets differ and names the extra path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DEFAULT_EXCLUDE_PATTERNS } from "../../../src/config.js";
import {
	createFileSelection,
	type FileSelection,
	isSelectedFile,
} from "../../../src/core/file-selection.js";
import { Indexer } from "../../../src/core/indexer.js";
import { getParserManager } from "../../../src/parsers/parser-manager.js";

let root: string;
let worktree: string;
let project: string;

function put(rel: string, text = "export const x = 1;\n"): void {
	const full = join(worktree, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeAll(async () => {
	await getParserManager().initialize();
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-f1-")));
	worktree = join(root, "wt");
	project = join(worktree, "pkg");
	// Inside the project subtree.
	put("pkg/src/a.ts");
	put("pkg/src/deep/b.py", "def b():\n    return 1\n");
	put("pkg/src/gen/skip.ts"); // excluded directory pattern
	put("pkg/src/c.gen.ts"); // excluded file pattern
	put("pkg/node_modules/dep/index.ts"); // ALWAYS_EXCLUDE_DIRS
	put("pkg/.mnemex/stray.ts"); // ALWAYS_EXCLUDE_DIRS
	put("pkg/notes.txt", "not code\n"); // unsupported extension
	put("pkg/lib/keep.ts");
	// A pattern that matches the DIRECTORY only, not the files under it: only
	// the walk's refusal to descend excludes `v.ts`, so only an ancestor check
	// can agree with it.
	put("pkg/src/vendored/v.ts");
	// Outside the project subtree, inside the worktree.
	put("other/outside.ts");
	put("top.ts");
	// A symlinked FILE and a symlinked DIRECTORY inside the project.
	symlinkSync(join(worktree, "top.ts"), join(project, "src", "link.ts"));
	mkdirSync(join(root, "elsewhere"), { recursive: true });
	writeFileSync(join(root, "elsewhere", "far.ts"), "export const far = 1;\n");
	symlinkSync(join(root, "elsewhere"), join(project, "src", "linkdir"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Every non-directory entry under `dir`, symlinks INCLUDED, as worktree-relative paths. */
function everyEntry(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else out.push(relative(worktree, full));
		}
	};
	walk(dir);
	// The symlinked directory's target, reached through the link: git would
	// never list it, but a careless predicate walking by path would accept it.
	out.push("pkg/src/linkdir/far.ts");
	return out.sort();
}

/** `Indexer.discoverFiles`, without the constructor's config reads. */
function discover(exclude: string[], include: string[]): string[] {
	const indexer = Object.create(Indexer.prototype) as Indexer & {
		excludePatterns: string[];
		includePatterns: string[];
		discoverFiles(root: string): string[];
	};
	indexer.excludePatterns = exclude;
	indexer.includePatterns = include;
	return indexer
		.discoverFiles(project)
		.map((abs) => relative(worktree, abs))
		.sort();
}

function selectedBy(selection: FileSelection): string[] {
	return everyEntry(worktree).filter((rel) => isSelectedFile(selection, rel));
}

const EXCLUDE = [
	...DEFAULT_EXCLUDE_PATTERNS,
	"src/gen/**",
	"**/*.gen.ts",
	"**/vendored",
];

describe("F-1 — isSelectedFile selects exactly discoverFiles' universe", () => {
	test("exclude patterns, subdirectory project, symlinks (A, exact set)", () => {
		const expected = discover(EXCLUDE, []);
		const selection = createFileSelection({
			projectRealPath: project,
			pathRoot: worktree,
			excludePatterns: EXCLUDE,
			includePatterns: [],
		});
		const actual = selectedBy(selection);
		expect(actual).toEqual(expected);
		// Non-vacuous: the walk found the files the fixture meant it to.
		expect(expected).toEqual([
			"pkg/lib/keep.ts",
			"pkg/src/a.ts",
			"pkg/src/deep/b.py",
		]);
	});

	test("include patterns are matched project-relative, as the walk does", () => {
		const include = ["src/**"];
		const expected = discover(EXCLUDE, include);
		const selection = createFileSelection({
			projectRealPath: project,
			pathRoot: worktree,
			excludePatterns: EXCLUDE,
			includePatterns: include,
		});
		expect(selectedBy(selection)).toEqual(expected);
		expect(expected).toEqual(["pkg/src/a.ts", "pkg/src/deep/b.py"]);
	});

	test("the project = worktree root case is the same equality", () => {
		const selection = createFileSelection({
			projectRealPath: worktree,
			pathRoot: worktree,
			excludePatterns: EXCLUDE,
			includePatterns: [],
		});
		const indexer = Object.create(Indexer.prototype) as Indexer & {
			excludePatterns: string[];
			includePatterns: string[];
			discoverFiles(root: string): string[];
		};
		indexer.excludePatterns = EXCLUDE;
		indexer.includePatterns = [];
		const expected = indexer
			.discoverFiles(worktree)
			.map((abs) => relative(worktree, abs))
			.sort();
		expect(selectedBy(selection)).toEqual(expected);
		expect(expected).toContain("top.ts");
		expect(expected).toContain("other/outside.ts");
	});

	test("an ABSENT path (a deletion) is decided by the patterns alone", () => {
		const selection = createFileSelection({
			projectRealPath: project,
			pathRoot: worktree,
			excludePatterns: EXCLUDE,
			includePatterns: [],
		});
		// Deleted files must stay candidates, or their index rows are never hidden.
		expect(isSelectedFile(selection, "pkg/src/deleted.ts")).toBe(true);
		expect(isSelectedFile(selection, "pkg/src/gone/deeper.ts")).toBe(true);
		expect(isSelectedFile(selection, "pkg/src/gen/deleted.ts")).toBe(false);
		expect(isSelectedFile(selection, "other/deleted.ts")).toBe(false);
		expect(isSelectedFile(selection, "pkg/node_modules/x/deleted.ts")).toBe(
			false,
		);
		expect(isSelectedFile(selection, "pkg/deleted.txt")).toBe(false);
	});

	test("paths that escape the worktree are never selected", () => {
		const selection = createFileSelection({
			projectRealPath: worktree,
			pathRoot: worktree,
			excludePatterns: EXCLUDE,
			includePatterns: [],
		});
		expect(isSelectedFile(selection, "../escape.ts")).toBe(false);
		expect(isSelectedFile(selection, "/etc/passwd.ts")).toBe(false);
		expect(isSelectedFile(selection, "")).toBe(false);
	});
});
