/**
 * P-8 — THE CHUNK-LABEL SPELLING SWEEP over `src/core/chunker.ts`
 * (iteration 2, F1).
 *
 * The dead-code penalty resolves `X (fields)` / `X (part n/m)` back to `X`
 * with the chunker's own grammar (`symbolNameOfChunkLabel`). That only works
 * while the chunker spells each label in exactly one place — the builders
 * `partLabel` and `fieldsLabel` — because the parser and the builders are kept
 * in step by a round-trip test, and a third template literal elsewhere in the
 * file would name chunks the parser was never shown.
 *
 * Rule: every string-like node (string, template string, regex) whose text
 * contains `(part ` or `(fields)` must lie inside one of the two builders.
 * Comments are not string nodes, so prose about the labels never fires.
 *
 * CLAUDE.md #32: a sweep is only as good as its scanner. This one uses
 * tree-sitter, and the result carries a census — lines the parse tree covers
 * against the file's real length, ERROR/MISSING nodes, and string-like nodes
 * scanned — which the test asserts before trusting an empty findings list.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

export const LABEL_BUILDERS: ReadonlySet<string> = new Set([
	"partLabel",
	"fieldsLabel",
]);

const LABEL_SPELLINGS = ["(part ", "(fields)"] as const;

const STRING_TYPES = new Set(["string", "template_string", "regex"]);

const FUNCTION_TYPES = new Set([
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"generator_function_declaration",
]);

export interface LabelFinding {
	/** Enclosing function name, or `<module>`. */
	readonly caller: string;
	/** 1-based line. */
	readonly line: number;
	readonly text: string;
}

export interface LabelSweepResult {
	readonly findings: readonly LabelFinding[];
	/** String-like nodes that contain a label spelling inside a builder. */
	readonly inBuilders: number;
	readonly census: {
		readonly fileLines: number;
		readonly linesCovered: number;
		readonly parseErrors: number;
		readonly stringNodesScanned: number;
	};
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walk(child, visit);
	}
}

function functionName(fn: Node): string {
	const own = fn.childForFieldName("name");
	if (own) return own.text;
	// `const partLabel = (…) => …` / `= function (…) {…}`
	const parent = fn.parent;
	if (parent?.type === "variable_declarator") {
		const name = parent.childForFieldName("name");
		if (name) return name.text;
	}
	return "<anonymous>";
}

function enclosingFunctionNames(node: Node): string[] {
	const names: string[] = [];
	let cur = node.parent;
	while (cur) {
		if (FUNCTION_TYPES.has(cur.type)) names.push(functionName(cur));
		cur = cur.parent;
	}
	return names;
}

function countLines(source: string): number {
	if (source.length === 0) return 0;
	const lines = source.split("\n").length;
	return source.endsWith("\n") ? lines - 1 : lines;
}

export function sweepChunkLabels(
	source: string,
	parser: Parser,
): LabelSweepResult {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	const root = tree.rootNode;

	let parseErrors = 0;
	let stringNodesScanned = 0;
	let inBuilders = 0;
	const findings: LabelFinding[] = [];
	walk(root, (n) => {
		if (n.type === "ERROR" || n.isMissing) parseErrors++;
		if (!STRING_TYPES.has(n.type)) return;
		stringNodesScanned++;
		if (!LABEL_SPELLINGS.some((s) => n.text.includes(s))) return;
		const enclosing = enclosingFunctionNames(n);
		if (enclosing.some((name) => LABEL_BUILDERS.has(name))) {
			inBuilders++;
			return;
		}
		findings.push({
			caller: enclosing[0] ?? "<module>",
			line: n.startPosition.row + 1,
			text: n.text.split("\n")[0],
		});
	});

	const covered = root.endPosition.row + (root.endPosition.column > 0 ? 1 : 0);
	return {
		findings,
		inBuilders,
		census: {
			fileLines: countLines(source),
			linesCovered: covered,
			parseErrors,
			stringNodesScanned,
		},
	};
}
