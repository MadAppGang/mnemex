/**
 * S-L — THE OVERLAY PATH SWEEP (step 3, R3.6/R3.7, D-2).
 *
 * The dirty overlay's directory, lock file, vectors directory and manifest
 * must each come from ONE resolver in `src/core/store-location.ts`, derived
 * from the worktree directory (`getWorktreeDirFor`). A second spelling — a
 * `join(projectPath, ".mnemex", "overlay")` like the cloud overlay's, or a
 * `"dirty-overlay"` literal in another file — is how a lock and the data it
 * guards end up in two places (D-2), and how the overlay lands in the SHARED
 * git-common-dir store that R3.6 forbids.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *   SL-name     a string literal containing `dirty-overlay` or `.overlay.lock`
 *               anywhere in `src/**` outside `store-location.ts`.
 *   SL-overlay  inside `src/core/overlay/**`: a string literal naming a path
 *               component the resolver owns — `.mnemex`, `manifest.json`,
 *               `vectors`, `dirty-overlay` — i.e. a hand-built overlay path.
 *
 * A MODULE SPECIFIER is not a path to overlay data: the source of an
 * `import`/`export … from` statement and the argument of a dynamic `import()`
 * are exempt (the overlay's own module is `src/core/overlay/dirty-overlay.ts`,
 * and `indexer.ts` must import it — phase 6). Exempt by the node's syntactic
 * POSITION, never by its text, so the same string handed to `join()` still
 * fires (planted both ways in `overlay-location-lock.test.ts`).
 *
 * ── SIGHT (CLAUDE.md #32) ──────────────────────────────────────────────────
 * Real tree-sitter parse per file (TypeScript grammar for `.ts`, TSX for
 * `.tsx`), and a census: files, the lines the parse trees cover against the
 * files' real lengths, and the ERROR/MISSING node count. The test asserts the
 * census before it trusts an empty findings list, and plants violations.
 *
 * The grammar does not parse every file in `src/` cleanly (measured: 13 files,
 * e.g. `import("./types.js").X` in a return-type position, `export type *`),
 * and an ERROR node may hide a string literal. So every line an ERROR/MISSING
 * node spans is ALSO checked as raw text for the `SL-name` fragments: a line
 * the parser could not read is read without it, and nothing is invisible.
 * The census reports those lines (`errorLines`) so their number is visible.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

export type OverlayPathRule = "SL-name" | "SL-overlay";

export interface OverlayPathFinding {
	rule: OverlayPathRule;
	file: string;
	line: number;
	text: string;
}

export interface OverlayPathCensus {
	files: number;
	fileLines: number;
	linesScanned: number;
	parseErrors: number;
	/** Files whose tree had an ERROR/MISSING node: anything there may hide code. */
	filesWithErrors: string[];
	/** String literals visited — the thing the rules read. */
	stringsScanned: number;
	/** Lines inside an ERROR/MISSING span, each re-read as raw text. */
	errorLines: number;
	/** String literals skipped because they are module specifiers. */
	moduleSpecifiersExempt: number;
}

export interface OverlayPathSweepResult {
	findings: OverlayPathFinding[];
	census: OverlayPathCensus;
}

/** The ONE file allowed to spell the overlay's names. */
export const OVERLAY_PATH_RESOLVER = "src/core/store-location.ts";

const NAME_FRAGMENTS = ["dirty-overlay", ".overlay.lock"];
const OVERLAY_COMPONENTS = [
	".mnemex",
	"manifest.json",
	"vectors",
	"dirty-overlay",
];

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walk(child, visit);
	}
}

/** Is this string node a module specifier (import/export source, `import()`)? */
function isModuleSpecifier(node: Node): boolean {
	const parent = node.parent;
	if (parent === null) return false;
	if (
		parent.type === "import_statement" ||
		parent.type === "export_statement"
	) {
		return true;
	}
	// `import("…")`: string -> arguments -> call_expression whose callee is `import`.
	if (parent.type === "arguments") {
		const call = parent.parent;
		return call?.type === "call_expression" && call.child(0)?.type === "import";
	}
	return false;
}

/** The literal text of a string-like node, without its quotes. */
function literalText(node: Node): string | null {
	if (node.type === "string") return node.text.slice(1, -1);
	if (node.type === "template_string") return node.text.slice(1, -1);
	return null;
}

export interface SweepFile {
	/** Repo-relative, `/`-separated. */
	path: string;
	source: string;
}

export function sweepOverlayPaths(
	files: readonly SweepFile[],
	parserFor: (path: string) => Parser,
): OverlayPathSweepResult {
	const findings: OverlayPathFinding[] = [];
	const census: OverlayPathCensus = {
		files: 0,
		fileLines: 0,
		linesScanned: 0,
		parseErrors: 0,
		filesWithErrors: [],
		stringsScanned: 0,
		errorLines: 0,
		moduleSpecifiersExempt: 0,
	};
	for (const file of files) {
		const tree = parserFor(file.path).parse(file.source);
		if (!tree) throw new Error(`parse failed: ${file.path}`);
		const root = tree.rootNode;
		census.files++;
		const lines = file.source.split("\n").length;
		census.fileLines += lines;
		census.linesScanned += Math.min(lines, root.endPosition.row + 1);
		let errors = 0;
		const errorLineSet = new Set<number>();
		const inOverlay = file.path.startsWith("src/core/overlay/");
		walk(root, (node) => {
			if (node.type === "ERROR" || node.isMissing) {
				errors++;
				for (
					let row = node.startPosition.row;
					row <= node.endPosition.row;
					row++
				) {
					errorLineSet.add(row);
				}
			}
			const text = literalText(node);
			if (text === null) return;
			census.stringsScanned++;
			if (isModuleSpecifier(node)) {
				census.moduleSpecifiersExempt++;
				return;
			}
			const line = node.startPosition.row + 1;
			if (
				file.path !== OVERLAY_PATH_RESOLVER &&
				NAME_FRAGMENTS.some((f) => text.includes(f))
			) {
				findings.push({ rule: "SL-name", file: file.path, line, text });
			}
			if (inOverlay && OVERLAY_COMPONENTS.some((c) => text === c)) {
				findings.push({ rule: "SL-overlay", file: file.path, line, text });
			}
		});
		if (errors > 0) {
			census.parseErrors += errors;
			census.filesWithErrors.push(file.path);
			census.errorLines += errorLineSet.size;
			// The raw-text fallback over every line the parser could not read.
			const lines = file.source.split("\n");
			for (const row of [...errorLineSet].sort((a, b) => a - b)) {
				const text = lines[row] ?? "";
				const seen = findings.some(
					(f) => f.file === file.path && f.line === row + 1,
				);
				if (
					!seen &&
					file.path !== OVERLAY_PATH_RESOLVER &&
					NAME_FRAGMENTS.some((f) => text.includes(f))
				) {
					findings.push({
						rule: "SL-name",
						file: file.path,
						line: row + 1,
						text: text.trim(),
					});
				}
			}
		}
		tree.delete();
	}
	return { findings, census };
}
