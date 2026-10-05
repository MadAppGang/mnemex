/**
 * M-5 — `OverlayMerger` never reaches the LOCAL search path (R3.2).
 *
 * The cloud merger min-max normalises the index list and the overlay list
 * independently, which put 34 dirty chunks in 57.5 % of the merged top 10
 * (D-MERGE, `step3-scope.md` §2.3). The local path merges candidates BEFORE
 * fusion instead (`VectorStore.search`); this sweep keeps the cloud merger out
 * of `src/core`, `src/mcp/tools` and `src/retrieval`.
 *
 * ── THE RULES, per file ────────────────────────────────────────────────────
 *   M5-import   a static `import`/`export … from`, a dynamic `import("…")` or a
 *               `require("…")` whose specifier RESOLVES (relative to the file)
 *               to `src/cloud/merger.ts` — `.js`, `.ts` or extensionless.
 *   M5-name     the identifier `OverlayMerger` anywhere in CODE (identifier,
 *               type identifier, property name, shorthand). This is what closes
 *               the re-export chain: `src/cloud/index.ts` re-exports the class,
 *               and `src/mcp/tools/search.ts` legitimately imports
 *               `cloud/index.js` for the cloud path — so "imports a module that
 *               re-exports it" cannot be the rule, but USING it must name it,
 *               including `cloud.OverlayMerger` through a namespace import.
 *               Comments and string literals are not code and do not fire.
 *
 * ── SIGHT (CLAUDE.md #32) ──────────────────────────────────────────────────
 * The census reports files, lines covered by each parse tree against the
 * file's real length, and ERROR/MISSING nodes. A parse error can hide code, so
 * every line inside an ERROR/MISSING span is ALSO re-read as raw text against
 * both rules (the same fallback as the S-L sweep).
 *
 * Limits: a specifier built at runtime (`import(base + "merger.js")`) is not a
 * literal and is not resolved; nothing in `src/` builds specifiers that way.
 * It reads source and executes none.
 */

import { dirname, join, normalize } from "node:path";
import type { Node, Parser } from "web-tree-sitter";

export const MERGER_MODULE = "src/cloud/merger.ts";
export const MERGER_CLASS = "OverlayMerger";
export const LOCAL_SEARCH_ROOTS = [
	"src/core/",
	"src/mcp/tools/",
	"src/retrieval/",
];

export type MergerRule = "M5-import" | "M5-name";

export interface MergerFinding {
	rule: MergerRule;
	file: string;
	line: number;
	text: string;
}

export interface MergerCensus {
	files: number;
	fileLines: number;
	linesScanned: number;
	parseErrors: number;
	errorLines: number;
	specifiers: number;
}

export interface SweepFile {
	/** Repo-relative, `/`-separated. */
	path: string;
	source: string;
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walk(child, visit);
	}
}

/** Repo-relative module a relative specifier names, extension-normalised. */
export function resolvesToMerger(fromFile: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const target = normalize(join(dirname(fromFile), specifier))
		.split("\\")
		.join("/");
	const stem = target.replace(/\.(?:js|ts|mjs|cjs|mts|cts)$/, "");
	return stem === MERGER_MODULE.replace(/\.ts$/, "");
}

function stringValue(node: Node): string | null {
	if (node.type !== "string") return null;
	return node.text.slice(1, -1);
}

const NAME_TYPES = new Set([
	"identifier",
	"type_identifier",
	"property_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
]);

const RAW_SPECIFIER =
	/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`]+)["'`]/g;

export function sweepOverlayMerger(
	files: readonly SweepFile[],
	parserFor: (path: string) => Parser,
): { findings: MergerFinding[]; census: MergerCensus } {
	const findings: MergerFinding[] = [];
	const census: MergerCensus = {
		files: 0,
		fileLines: 0,
		linesScanned: 0,
		parseErrors: 0,
		errorLines: 0,
		specifiers: 0,
	};
	for (const file of files) {
		const tree = parserFor(file.path).parse(file.source);
		if (!tree) throw new Error(`parse failed: ${file.path}`);
		const root = tree.rootNode;
		const lines = file.source.split("\n");
		census.files++;
		census.fileLines += lines.length;
		census.linesScanned += Math.min(lines.length, root.endPosition.row + 1);
		const errorRows = new Set<number>();
		const add = (rule: MergerRule, node: Node) =>
			findings.push({
				rule,
				file: file.path,
				line: node.startPosition.row + 1,
				text: lines[node.startPosition.row]?.trim() ?? "",
			});
		walk(root, (node) => {
			if (node.type === "ERROR" || node.isMissing) {
				census.parseErrors++;
				for (let r = node.startPosition.row; r <= node.endPosition.row; r++) {
					errorRows.add(r);
				}
			}
			if (NAME_TYPES.has(node.type) && node.text === MERGER_CLASS) {
				add("M5-name", node);
			}
			// import … from "x" / export … from "x"
			if (
				node.type === "import_statement" ||
				node.type === "export_statement"
			) {
				const source = node.childForFieldName("source");
				const spec = source ? stringValue(source) : null;
				if (spec !== null) {
					census.specifiers++;
					if (resolvesToMerger(file.path, spec)) add("M5-import", node);
				}
			}
			// import("x") / require("x")
			if (node.type === "call_expression") {
				const fn = node.childForFieldName("function");
				const callee = fn?.type === "import" ? "import" : fn?.text;
				if (callee === "import" || callee === "require") {
					const args = node.childForFieldName("arguments");
					const first = args?.namedChild(0);
					const spec = first ? stringValue(first) : null;
					if (spec !== null) {
						census.specifiers++;
						if (resolvesToMerger(file.path, spec)) add("M5-import", node);
					}
				}
			}
		});
		census.errorLines += errorRows.size;
		for (const row of [...errorRows].sort((a, b) => a - b)) {
			const text = lines[row] ?? "";
			const already = findings.some(
				(f) => f.file === file.path && f.line === row + 1,
			);
			if (already) continue;
			const named = new RegExp(`\\b${MERGER_CLASS}\\b`).test(text);
			const imported = [...text.matchAll(RAW_SPECIFIER)].some((m) =>
				resolvesToMerger(file.path, m[1]),
			);
			if (named || imported) {
				findings.push({
					rule: imported ? "M5-import" : "M5-name",
					file: file.path,
					line: row + 1,
					text: text.trim(),
				});
			}
		}
		tree.delete();
	}
	return { findings, census };
}
