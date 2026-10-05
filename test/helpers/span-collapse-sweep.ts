/**
 * S-R2 — THE SPAN-COLLAPSE SWEEP over `src/core/store.ts` (R2.4).
 *
 * R2 says one span, one result slot, on EVERY local path that returns ranked
 * code. The paths are recognisable by one shape: they call a rank-fusion
 * function (`typeAwareRRFFusion` or `reciprocalRankFusion`) and then cut the
 * fused list to the caller's `limit`. A fourth such path added later without
 * the collapse would put the twins back, and a test of the three known paths
 * would not notice.
 *
 * ── THE RULES, per function that calls a fusion function ────────────────────
 *   R2-no-collapse            no `collapseSpanTwins(…)` call after the fusion
 *   R2-collapse-before-fusion a `collapseSpanTwins(…)` call that precedes every
 *                             fusion call (it cannot be collapsing the fused list)
 *   R2-limit-slice            a `.slice(…)` whose arguments name `limit` — the
 *                             collapse IS the cut; a second cut by `limit` is
 *                             either redundant or, before the collapse, the bug
 *
 * ── WHY TREE-SITTER, AND WHY THE CENSUS ─────────────────────────────────────
 * CLAUDE.md #32: two earlier sweeps were blind over ~1 100 lines of exactly
 * this file because a hand-rolled stripper paired the apostrophe in the regex
 * literal `.replace(/'/g, "''")` with the next quote in the file. A parser has
 * no such failure mode, but a parse ERROR node can still swallow code. So the
 * result carries a census — lines the parse tree covers against the file's
 * real length, the count of ERROR/MISSING nodes, and the functions visited —
 * and the test asserts on it before it trusts an empty findings list.
 *
 * Limits: intra-function and syntactic. A fusion call reached through a local
 * alias (`const f = typeAwareRRFFusion; f(…)`) is not recognised; neither file
 * does that today, and the census pins the set of fusion callers by name, so a
 * caller the sweep stops seeing turns the test red rather than silent.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

export const FUSION_FUNCTIONS: ReadonlySet<string> = new Set([
	"typeAwareRRFFusion",
	"reciprocalRankFusion",
]);

export const COLLAPSE_FUNCTION = "collapseSpanTwins";

export type SpanRule =
	| "R2-no-collapse"
	| "R2-collapse-before-fusion"
	| "R2-limit-slice";

export interface SpanFinding {
	rule: SpanRule;
	/** Name of the enclosing function or method. */
	caller: string;
	/** 1-based line of the offending (or, for R2-no-collapse, fusion) call. */
	line: number;
	text: string;
}

export interface SpanSweepCensus {
	/** Enclosing functions that call a fusion function, sorted. */
	fusionCallers: string[];
	/** Lines spanned by the parse tree's root node. */
	linesScanned: number;
	/** Lines in the source. */
	fileLines: number;
	/** ERROR and MISSING nodes in the tree: anything here may hide code. */
	parseErrors: number;
	/** Function-like nodes visited. */
	functionsScanned: number;
}

export interface SpanSweepResult {
	findings: SpanFinding[];
	census: SpanSweepCensus;
}

const FUNCTION_TYPES = new Set([
	"arrow_function",
	"function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walk(child, visit);
	}
}

/** `f(…)` → "f"; `a.b.f(…)` → "f"; anything else → null. */
function calleeName(call: Node): string | null {
	const fn = call.childForFieldName("function");
	if (!fn) return null;
	if (fn.type === "identifier") return fn.text;
	if (fn.type === "member_expression") {
		return fn.childForFieldName("property")?.text ?? null;
	}
	return null;
}

function functionName(fn: Node): string {
	const own = fn.childForFieldName("name");
	if (own) return own.text;
	// `const f = (…) => …` / `const f = function (…) {…}`
	const parent = fn.parent;
	if (parent?.type === "variable_declarator") {
		const name = parent.childForFieldName("name");
		if (name) return name.text;
	}
	return `<anonymous@${fn.startPosition.row + 1}>`;
}

/**
 * The OUTERMOST named function containing `node` — the method, not an arrow
 * callback inside it, so a `.map((r) => …)` around the cut does not move the
 * cut into a different "caller".
 */
function enclosingCaller(node: Node): Node | null {
	let found: Node | null = null;
	for (let p = node.parent; p; p = p.parent) {
		if (
			p.type === "method_definition" ||
			p.type === "function_declaration" ||
			p.type === "generator_function_declaration"
		) {
			return p;
		}
		if (FUNCTION_TYPES.has(p.type)) found = p;
	}
	return found;
}

function firstLine(node: Node): string {
	return (node.text.split("\n")[0] ?? "").trim();
}

function countLines(source: string): number {
	if (source.length === 0) return 0;
	const lines = source.split("\n").length;
	return source.endsWith("\n") ? lines - 1 : lines;
}

export function sweepSpanCollapse(
	source: string,
	parser: Parser,
): SpanSweepResult {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	const root = tree.rootNode;

	let parseErrors = 0;
	let functionsScanned = 0;
	const calls: Node[] = [];
	walk(root, (n) => {
		if (n.type === "ERROR" || n.isMissing) parseErrors++;
		if (FUNCTION_TYPES.has(n.type)) functionsScanned++;
		if (n.type === "call_expression") calls.push(n);
	});

	// Group fusion calls by their enclosing caller. Keyed by the node's `id`:
	// web-tree-sitter hands out a fresh wrapper object per `.parent` access, so
	// object identity would never group two calls in one method.
	const fusionCallsOf = new Map<number, { caller: Node; fusions: Node[] }>();
	for (const call of calls) {
		const name = calleeName(call);
		if (name === null || !FUSION_FUNCTIONS.has(name)) continue;
		const caller = enclosingCaller(call);
		if (!caller) continue;
		const entry = fusionCallsOf.get(caller.id) ?? { caller, fusions: [] };
		entry.fusions.push(call);
		fusionCallsOf.set(caller.id, entry);
	}

	const findings: SpanFinding[] = [];
	const within = (outer: Node, inner: Node) =>
		inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;

	for (const { caller, fusions } of fusionCallsOf.values()) {
		const name = functionName(caller);
		const lastFusionEnd = Math.max(...fusions.map((f) => f.endIndex));
		const firstFusionStart = Math.min(...fusions.map((f) => f.startIndex));
		const inCaller = calls.filter((c) => within(caller, c));

		const collapses = inCaller.filter(
			(c) => calleeName(c) === COLLAPSE_FUNCTION,
		);
		const after = collapses.filter((c) => c.startIndex >= lastFusionEnd);
		if (after.length === 0) {
			const anchor = fusions[fusions.length - 1];
			findings.push({
				rule: "R2-no-collapse",
				caller: name,
				line: anchor.startPosition.row + 1,
				text: firstLine(anchor),
			});
		}
		for (const c of collapses) {
			if (c.endIndex <= firstFusionStart) {
				findings.push({
					rule: "R2-collapse-before-fusion",
					caller: name,
					line: c.startPosition.row + 1,
					text: firstLine(c),
				});
			}
		}

		for (const c of inCaller) {
			if (calleeName(c) !== "slice") continue;
			const args = c.childForFieldName("arguments");
			if (!args) continue;
			let namesLimit = false;
			walk(args, (n) => {
				if (n.type === "identifier" && n.text === "limit") namesLimit = true;
			});
			if (namesLimit) {
				findings.push({
					rule: "R2-limit-slice",
					caller: name,
					line: c.startPosition.row + 1,
					text: firstLine(c),
				});
			}
		}
	}

	return {
		findings,
		census: {
			fusionCallers: [...fusionCallsOf.values()]
				.map((e) => functionName(e.caller))
				.sort(),
			linesScanned:
				root.endPosition.row + (root.endPosition.column > 0 ? 1 : 0),
			fileLines: countLines(source),
			parseErrors,
			functionsScanned,
		},
	};
}
