/**
 * THE REGION SWEEP — the static half of the tracker's blocking bound (V2.10).
 *
 * `src/core/tracker.ts` bounds each SQLite statement it runs by running it
 * inside `withRegion(region, fn)`, which sets `busy_timeout` to the region's
 * DIVIDED allowance before the first statement and back to 0 after the last
 * (`src/core/sync-region.ts`, THE ARITHMETIC). That bound is only as good as two
 * claims about SOURCE — every statement is inside a region (SR-1), and no two
 * regions run without a yield between them (SR-2) — so they are checked on
 * source. Over a tree-sitter AST rather than a regex: comments are their own
 * nodes (so the sweep is comment-stripped by construction), and SQL text inside
 * a string is never mistaken for a call.
 *
 * Rules:
 *   SR-1   every `.prepare(` / `.exec(` call sits lexically inside a
 *          `withRegion(` callback, or inside the `withRegion` method's own body
 *          — the machinery, whose statements ARE the clamp and BEGIN IMMEDIATE.
 *   SR-1b  every `.run(` / `.get(` / `.all(` on an identifier bound to a
 *          `.prepare(` result is inside a region callback too: a statement
 *          prepared inside a region and executed outside it has escaped.
 *   SR-1c  a region callback is SYNCHRONOUS — no `async`, no `await`.
 *          `withRegion` is synchronous, so an async callback's statements after
 *          its first await would run after the region had rested at 0.
 *   SR-1d  no `withRegion(` inside a region callback: regions do not nest.
 *   SR-2   a `for`/`while`/`do` body containing a `withRegion(` call has an
 *          `await` (in the loop's own function) between each region and the
 *          next, INCLUDING the wrap-around from the last region of one iteration
 *          to the first of the next; a body with a region and no await fails.
 *          A region inside a callback handed to an array iterator (`map`,
 *          `forEach`, …) is a loop that cannot await, and fails outright.
 *   N32    no `.transaction(` call. `sqlite.ts`'s Bun branch implements it as a
 *          DEFERRED `BEGIN`, and R-txn's count of 2 rests on BEGIN IMMEDIATE.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";
import { getParserManager } from "../../src/parsers/parser-manager.js";

export type RegionRule = "SR-1" | "SR-1b" | "SR-1c" | "SR-1d" | "SR-2" | "N32";

export interface RegionFinding {
	rule: RegionRule;
	/** 1-based. */
	line: number;
	/** First line of the offending node's source. */
	text: string;
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

const LOOP_TYPES = new Set([
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
]);

/** Array methods that invoke their callback once per element, synchronously. */
const ITERATOR_METHODS = new Set([
	"forEach",
	"map",
	"flatMap",
	"filter",
	"reduce",
	"reduceRight",
	"some",
	"every",
	"find",
	"findIndex",
]);

const PREPARED_EXECUTORS = new Set(["run", "get", "all"]);

let parserPromise: Promise<Parser> | null = null;

/** The TypeScript grammar the rest of the repo's AST sweeps use. */
export function typescriptParser(): Promise<Parser> {
	parserPromise ??= (async () => {
		const manager = getParserManager();
		await manager.initialize();
		const parser = await manager.getParser("typescript");
		if (!parser) {
			throw new Error(
				"typescript grammar unavailable — run `bun run download-grammars`",
			);
		}
		return parser;
	})();
	return parserPromise;
}

function namedChildren(node: Node): Node[] {
	const out: Node[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child) out.push(child);
	}
	return out;
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (const child of namedChildren(node)) walk(child, visit);
}

/**
 * web-tree-sitter builds a FRESH `Node` object on every `.parent` access, so
 * identity is compared by span and type, never with `===`.
 */
function sameNode(a: Node | null, b: Node | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.startIndex === b.startIndex &&
		a.endIndex === b.endIndex &&
		a.type === b.type
	);
}

/** `x.name(` → "name"; `name(` → "name". */
function calleeName(call: Node): string | null {
	const fn = call.childForFieldName("function");
	if (!fn) return null;
	if (fn.type === "identifier") return fn.text;
	if (fn.type === "member_expression") {
		return fn.childForFieldName("property")?.text ?? null;
	}
	return null;
}

/** `ident.name(` → "ident", when the receiver is a bare identifier. */
function receiverIdentifier(call: Node): string | null {
	const fn = call.childForFieldName("function");
	if (fn?.type !== "member_expression") return null;
	const receiver = fn.childForFieldName("object");
	return receiver?.type === "identifier" ? receiver.text : null;
}

/** A function node passed as an argument to a call named `name`. */
function isCallbackOf(node: Node, names: ReadonlySet<string>): boolean {
	if (!FUNCTION_TYPES.has(node.type)) return false;
	const args = node.parent;
	if (args?.type !== "arguments") return false;
	const call = args.parent;
	if (call?.type !== "call_expression") return false;
	const name = calleeName(call);
	return name !== null && names.has(name);
}

const REGION = new Set(["withRegion"]);

function enclosingRegionCallback(node: Node): Node | null {
	for (let p = node.parent; p; p = p.parent) {
		if (isCallbackOf(p, REGION)) return p;
	}
	return null;
}

function insideMachinery(node: Node): boolean {
	for (let p = node.parent; p; p = p.parent) {
		if (
			p.type === "method_definition" &&
			p.childForFieldName("name")?.text === "withRegion"
		) {
			return true;
		}
	}
	return false;
}

function enclosingFunction(node: Node): Node | null {
	for (let p = node.parent; p; p = p.parent) {
		if (FUNCTION_TYPES.has(p.type)) return p;
	}
	return null;
}

function insideIteratorCallback(node: Node): boolean {
	for (let p = node.parent; p; p = p.parent) {
		if (isCallbackOf(p, ITERATOR_METHODS)) return true;
	}
	return false;
}

/** Unwrap `x as T`, `(x)`, `x!` and `x satisfies T` to the expression beneath. */
function unwrap(node: Node): Node {
	let current = node;
	while (
		current.type === "as_expression" ||
		current.type === "satisfies_expression" ||
		current.type === "parenthesized_expression" ||
		current.type === "non_null_expression"
	) {
		const inner = current.namedChild(0);
		if (!inner) break;
		current = inner;
	}
	return current;
}

function finding(rule: RegionRule, node: Node): RegionFinding {
	return {
		rule,
		line: node.startPosition.row + 1,
		text: (node.text.split("\n")[0] ?? "").trim(),
	};
}

/**
 * What the sweep SAW: region calls, and `.prepare(`/`.exec(` calls. A clean
 * result over a file with no statements would prove nothing, so the caller
 * asserts these are non-trivial alongside the empty findings.
 */
export function regionCensus(
	source: string,
	parser: Parser,
): { regions: number; statements: number } {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	let regions = 0;
	let statements = 0;
	walk(tree.rootNode, (node) => {
		if (node.type !== "call_expression") return;
		const name = calleeName(node);
		if (name === "withRegion") regions++;
		else if (name === "prepare" || name === "exec") statements++;
	});
	return { regions, statements };
}

/**
 * Every rule above, over one source file. Empty means clean.
 *
 * Limit, stated so nobody trusts more than this proves: SR-1b follows a
 * prepared statement only through a NAME bound in this file. A statement
 * returned out of a region callback and executed by a caller is invisible to
 * it; `tracker-regions.test.ts`'s driver-seam test catches that case by
 * recording the busy_timeout in force at the moment each statement EXECUTES.
 */
export function sweepRegionSource(
	source: string,
	parser: Parser,
): RegionFinding[] {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");

	const calls: Node[] = [];
	const loops: Node[] = [];
	const preparedNames = new Set<string>();

	walk(tree.rootNode, (node) => {
		if (node.type === "call_expression") {
			calls.push(node);
		} else if (LOOP_TYPES.has(node.type)) {
			loops.push(node);
		} else if (
			node.type === "variable_declarator" ||
			node.type === "assignment_expression"
		) {
			// `const s = x.prepare(…)` and `s = x.prepare(…)` both bind a statement.
			const name =
				node.childForFieldName("name") ?? node.childForFieldName("left");
			const value =
				node.childForFieldName("value") ?? node.childForFieldName("right");
			if (name?.type === "identifier" && value) {
				const bound = unwrap(value);
				if (
					bound.type === "call_expression" &&
					calleeName(bound) === "prepare"
				) {
					preparedNames.add(name.text);
				}
			}
		}
	});

	const findings: RegionFinding[] = [];

	for (const call of calls) {
		const name = calleeName(call);
		const inRegion = enclosingRegionCallback(call) !== null;

		if (name === "prepare" || name === "exec") {
			if (!inRegion && !insideMachinery(call)) {
				findings.push(finding("SR-1", call));
			}
		} else if (name !== null && PREPARED_EXECUTORS.has(name)) {
			const receiver = receiverIdentifier(call);
			if (
				receiver !== null &&
				preparedNames.has(receiver) &&
				!inRegion &&
				!insideMachinery(call)
			) {
				findings.push(finding("SR-1b", call));
			}
		} else if (name === "transaction") {
			findings.push(finding("N32", call));
		} else if (name === "withRegion") {
			if (inRegion) findings.push(finding("SR-1d", call));
			if (insideIteratorCallback(call)) findings.push(finding("SR-2", call));

			const args = call.childForFieldName("arguments");
			for (const arg of args ? namedChildren(args) : []) {
				if (!FUNCTION_TYPES.has(arg.type)) continue;
				let awaits = false;
				walk(arg, (node) => {
					if (
						node.type === "await_expression" &&
						sameNode(enclosingFunction(node), arg)
					) {
						awaits = true;
					}
				});
				if (arg.text.trimStart().startsWith("async") || awaits) {
					findings.push(finding("SR-1c", arg));
				}
			}
		}
	}

	for (const loop of loops) {
		const body = loop.childForFieldName("body");
		if (!body) continue;
		const loopFunction = enclosingFunction(loop);

		const regions: Node[] = [];
		const awaits: number[] = [];
		walk(body, (node) => {
			if (
				node.type === "call_expression" &&
				calleeName(node) === "withRegion"
			) {
				regions.push(node);
			} else if (
				node.type === "await_expression" &&
				sameNode(enclosingFunction(node), loopFunction)
			) {
				awaits.push(node.startIndex);
			}
		});
		if (regions.length === 0) continue;
		regions.sort((a, b) => a.startIndex - b.startIndex);

		if (awaits.length === 0) {
			findings.push(finding("SR-2", regions[0] as Node));
			continue;
		}
		const first = regions[0] as Node;
		for (let i = 0; i < regions.length; i++) {
			const current = regions[i] as Node;
			const next = regions[i + 1];
			const yielded = next
				? awaits.some((p) => p >= current.endIndex && p < next.startIndex)
				: // wrap-around: last region of iteration k → first of iteration k+1
					awaits.some((p) => p >= current.endIndex || p < first.startIndex);
			if (!yielded) findings.push(finding("SR-2", next ?? first));
		}
	}

	return findings.sort((a, b) => a.line - b.line);
}
