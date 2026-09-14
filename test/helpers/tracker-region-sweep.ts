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
 *   SR-2   inside every `for`/`for…of`/`while`/`do` loop, no REGION-REACHING
 *          CALL is reached while an earlier one is still PENDING — that is,
 *          with no `await yieldToEventLoop();` statement executed since. This
 *          INCLUDES the wrap-around from the last region of one iteration to
 *          the first of the next. A region-reaching call inside a callback
 *          handed to an array iterator (`map`, `forEach`, …) is a loop that
 *          cannot yield between elements, and fails outright; so does a
 *          reference to `withRegion` that is not a call's callee, because the
 *          analysis could not see the regions it opens.
 *   N32    no `.transaction(` call. `sqlite.ts`'s Bun branch implements it as a
 *          DEFERRED `BEGIN`, and R-txn's count of 2 rests on BEGIN IMMEDIATE.
 *
 * ── SR-2: WHAT COUNTS AS A YIELD — ONE THING ────────────────────────────────
 * Only the statement `await yieldToEventLoop();`. NOT any `await`. An `await`
 * on a promise that has already resolved continues as a MICROTASK, and timers
 * never run between microtasks, so the lock heartbeat's `setInterval` stays
 * starved across it. Measured in this repository
 * (`implementation-log-indexer-regions.md`, Finding A): the real
 * `extractSymbols`/`extractReferences` loop over 400 files ran 2 377 ms with
 * ZERO ticks of a 20 ms `setInterval`, through a loop full of `await`s. Until
 * this revision SR-2 accepted ANY `await` between two regions, which accepted
 * exactly that shape. `indexer-loop-sweep.ts` (the caller-side sweep over
 * `indexer.ts`) already used this model; SR-2 now matches it.
 *
 * ── SR-2: A FLOW WALK, NOT A LEXICAL "IS THERE A YIELD BETWEEN" ─────────────
 * Each program point is PENDING (a region ran since the last yield) or settled.
 * The walk follows `if`/`else`, `try`/`catch`/`finally` (a `catch` is entered
 * pending if its `try` contains a region), `switch`, `continue`/`break` (with
 * labels), `return`/`throw`, nested loops, and each loop's WRAP-AROUND to a
 * fixpoint. So a yield in one branch of an `if` does not settle the other
 * branch, and a `continue` that skips the yield is seen. The engine is the one
 * in `indexer-loop-sweep.ts`, ported rather than shared because that file
 * belongs to a separate change; only the region recogniser differs.
 *
 * ── SR-2: WHAT COUNTS AS A REGION-REACHING CALL ─────────────────────────────
 *   - a `withRegion(` call;
 *   - `this.m(…)` where method `m` of this file reaches a region, and `f(…)`
 *     where local function `f` does — to a fixpoint. A body reaches if it
 *     contains a region-reaching call ANYWHERE, nested functions included
 *     (conservative: a region deferred into a callback still counts).
 *
 * ── LIMITS, stated so nobody trusts more than this proves ──────────────────
 *   - INTRA-FILE and `this.`-only: a call on another instance
 *     (`other.markIndexed()`), through `super`, `.call`/`.apply`, or a
 *     `new FileTracker(…)` in a loop is not recognised as a region.
 *   - STRAIGHT-LINE code outside any loop is not checked: a constant number of
 *     back-to-back regions is bounded by that count.
 *   - CONSERVATIVE on purpose: `a ? this.x() : this.y()` counts two regions,
 *     and a yield that is not the bare statement `await yieldToEventLoop();`
 *     (`const v = await yieldToEventLoop();`, an async helper that yields
 *     internally) is not recognised. Both can only produce a false finding.
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
	"findLast",
	"findLastIndex",
	"sort",
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

/** Pre-order walk; `visit` returning `false` prunes that node's subtree. */
function walk(node: Node, visit: (n: Node) => boolean | undefined): void {
	if (visit(node) === false) return;
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

function finding(rule: RegionRule, node: Node): RegionFinding {
	return {
		rule,
		line: node.startPosition.row + 1,
		text: (node.text.split("\n")[0] ?? "").trim(),
	};
}

/** The ONE shape SR-2 accepts as a yield: the statement `await yieldToEventLoop();`. */
function isYieldStatement(stmt: Node): boolean {
	if (stmt.type !== "expression_statement") return false;
	const expr = stmt.namedChild(0);
	if (expr?.type !== "await_expression") return false;
	const call = expr.namedChild(0);
	const fn = call?.childForFieldName("function");
	return (
		call?.type === "call_expression" &&
		fn?.type === "identifier" &&
		fn.text === "yieldToEventLoop" &&
		(call.childForFieldName("arguments")?.namedChildCount ?? 0) === 0
	);
}

// ════════════════════════════════════════════════════════════════════════════
// Which calls reach a region
// ════════════════════════════════════════════════════════════════════════════

interface Reach {
	methods: ReadonlySet<string>;
	functions: ReadonlySet<string>;
}

/** `this.m` (through `!`/parens) → "m". */
function thisMethodName(fn: Node): string | null {
	const f = unwrap(fn);
	if (f.type !== "member_expression") return null;
	if (f.childForFieldName("object")?.type !== "this") return null;
	return f.childForFieldName("property")?.text ?? null;
}

function isRegionCall(call: Node, reach: Reach): boolean {
	if (calleeName(call) === "withRegion") return true;
	const fn = call.childForFieldName("function");
	if (!fn) return false;
	const method = thisMethodName(fn);
	if (method !== null) return reach.methods.has(method);
	const f = unwrap(fn);
	return f.type === "identifier" && reach.functions.has(f.text);
}

/** Methods and local functions of this file that reach a region, to a fixpoint. */
function computeReach(root: Node): Reach {
	const methodNodes = new Map<string, Node[]>();
	const functionNodes = new Map<string, Node[]>();
	const add = (map: Map<string, Node[]>, name: string, node: Node) => {
		const list = map.get(name) ?? [];
		list.push(node);
		map.set(name, list);
	};
	walk(root, (node) => {
		const name = node.childForFieldName("name");
		if (node.type === "method_definition" && name) {
			add(methodNodes, name.text, node);
		} else if (
			(node.type === "function_declaration" ||
				node.type === "generator_function_declaration") &&
			name
		) {
			add(functionNodes, name.text, node);
		} else if (node.type === "variable_declarator") {
			const value = node.childForFieldName("value");
			if (
				name?.type === "identifier" &&
				value &&
				FUNCTION_TYPES.has(value.type)
			) {
				add(functionNodes, name.text, value);
			}
		}
		return undefined;
	});

	const methods = new Set<string>();
	const functions = new Set<string>();
	const reach: Reach = { methods, functions };
	const bodyReaches = (fn: Node): boolean => {
		const body = fn.childForFieldName("body");
		if (!body) return false;
		let found = false;
		walk(body, (n) => {
			if (found) return false;
			if (n.type === "call_expression" && isRegionCall(n, reach)) found = true;
			return undefined;
		});
		return found;
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, nodes] of methodNodes) {
			if (!methods.has(name) && nodes.some(bodyReaches)) {
				methods.add(name);
				changed = true;
			}
		}
		for (const [name, nodes] of functionNodes) {
			if (!functions.has(name) && nodes.some(bodyReaches)) {
				functions.add(name);
				changed = true;
			}
		}
	}
	return reach;
}

// ════════════════════════════════════════════════════════════════════════════
// SR-2's flow walk — indexer-loop-sweep.ts's engine, this file's recogniser
// ════════════════════════════════════════════════════════════════════════════

/** true = a region ran since the last yield; false = settled; null = unreachable. */
type State = boolean | null;

function join(a: State, b: State): State {
	if (a === null) return b;
	if (b === null) return a;
	return a || b;
}

interface JumpTarget {
	kind: "loop" | "switch";
	label: string | null;
	continueState: State;
	breakState: State;
}

interface LoopFlow {
	/** Region-reaching calls reached while an earlier one was pending. */
	violations: Node[];
	/** Loops whose head, body or update reaches at least one region. */
	regionLoops: number;
}

function flowLoops(root: Node, reach: Reach): LoopFlow {
	const violations = new Map<number, Node>();
	const regionLoops = new Set<number>();
	const targets: JumpTarget[] = [];
	let recording = true;

	/** Region calls inside `node`, not descending into nested functions. */
	function regionCallsIn(node: Node): Node[] {
		const out: Node[] = [];
		walk(node, (n) => {
			if (n !== node && FUNCTION_TYPES.has(n.type)) return false;
			if (n.type === "call_expression" && isRegionCall(n, reach)) out.push(n);
			return undefined;
		});
		return out.sort((a, b) => a.startIndex - b.startIndex);
	}

	function flowExpr(node: Node | null, s: State): State {
		if (!node || s === null) return s;
		let state = s;
		for (const call of regionCallsIn(node)) {
			if (state === true && recording) violations.set(call.startIndex, call);
			state = true;
		}
		return state;
	}

	function flowList(nodes: Node[], s: State): State {
		let state = s;
		for (const n of nodes) state = flowStatement(n, state);
		return state;
	}

	function findTarget(
		kind: "continue" | "break",
		label: string | null,
	): JumpTarget | undefined {
		for (let i = targets.length - 1; i >= 0; i--) {
			const t = targets[i] as JumpTarget;
			if (label !== null) {
				if (t.label === label) return t;
				continue;
			}
			if (kind === "continue" && t.kind !== "loop") continue;
			return t;
		}
		return undefined;
	}

	function flowStatement(node: Node, s: State): State {
		if (s === null) return null;
		switch (node.type) {
			case "comment":
			case "empty_statement":
			case "function_declaration":
			case "generator_function_declaration":
			case "class_declaration":
				return s;
			case "statement_block":
			case "else_clause":
				return flowList(namedChildren(node), s);
			case "expression_statement":
				return isYieldStatement(node) ? false : flowExpr(node, s);
			case "if_statement": {
				const c = flowExpr(node.childForFieldName("condition"), s);
				const cons = node.childForFieldName("consequence");
				const alt = node.childForFieldName("alternative");
				const a = cons ? flowStatement(cons, c) : c;
				const b = alt ? flowStatement(alt, c) : c;
				return join(a, b);
			}
			case "try_statement": {
				const body = node.childForFieldName("body");
				const handler = node.childForFieldName("handler");
				const finalizer = node.childForFieldName("finalizer");
				const b = body ? flowStatement(body, s) : s;
				// An exception can leave the body right after any region in it.
				const threw = join(
					s,
					body && regionCallsIn(body).length > 0 ? true : s,
				);
				let after = b;
				if (handler) {
					const hb = handler.childForFieldName("body");
					after = join(b, hb ? flowStatement(hb, threw) : threw);
				}
				if (finalizer) {
					const fb = finalizer.childForFieldName("body");
					const out = fb ? flowStatement(fb, join(after, threw)) : after;
					return after === null ? null : out;
				}
				return after;
			}
			case "labeled_statement": {
				const label = node.childForFieldName("label")?.text ?? null;
				const body = node.childForFieldName("body");
				if (body && LOOP_TYPES.has(body.type)) return flowLoop(body, s, label);
				return body ? flowStatement(body, s) : s;
			}
			case "for_statement":
			case "for_in_statement":
			case "while_statement":
			case "do_statement":
				return flowLoop(node, s, null);
			case "switch_statement": {
				const value = flowExpr(node.childForFieldName("value"), s);
				const body = node.childForFieldName("body");
				const target: JumpTarget = {
					kind: "switch",
					label: null,
					continueState: null,
					breakState: null,
				};
				targets.push(target);
				let out: State = null;
				let fall: State = null;
				for (const c of body ? namedChildren(body) : []) {
					const caseValue = c.childForFieldName("value");
					const stmts = namedChildren(c).filter(
						(x) => x.startIndex !== caseValue?.startIndex,
					);
					fall = flowList(stmts, flowExpr(caseValue, join(value, fall)));
					out = join(out, fall);
				}
				targets.pop();
				return join(join(out, target.breakState), value);
			}
			case "continue_statement":
			case "break_statement": {
				const label =
					namedChildren(node).find((c) => c.type === "statement_identifier")
						?.text ?? null;
				const kind = node.type === "continue_statement" ? "continue" : "break";
				const t = findTarget(kind, label);
				if (t) {
					if (kind === "continue") t.continueState = join(t.continueState, s);
					else t.breakState = join(t.breakState, s);
				}
				return null;
			}
			case "return_statement":
			case "throw_statement":
				flowExpr(node, s);
				return null;
			default:
				return flowExpr(node, s);
		}
	}

	function flowLoop(loop: Node, s: State, label: string | null): State {
		const body = loop.childForFieldName("body");
		let entry = s;
		let condition: Node | null = null;
		let increment: Node | null = null;
		if (loop.type === "for_statement") {
			const init = loop.childForFieldName("initializer");
			entry = init ? flowStatement(init, s) : s;
			condition = loop.childForFieldName("condition");
			increment = loop.childForFieldName("increment");
		} else if (loop.type === "for_in_statement") {
			entry = flowExpr(loop.childForFieldName("right"), s);
		} else {
			condition = loop.childForFieldName("condition");
		}
		const reaches =
			(body ? regionCallsIn(body).length : 0) +
			(condition ? regionCallsIn(condition).length : 0) +
			(increment ? regionCallsIn(increment).length : 0);
		if (reaches > 0) regionLoops.add(loop.startIndex);

		/** One turn: condition, body, `continue` states, increment. */
		const turn = (head: State): { end: State; target: JumpTarget } => {
			const target: JumpTarget = {
				kind: "loop",
				label,
				continueState: null,
				breakState: null,
			};
			targets.push(target);
			let state: State;
			if (loop.type === "do_statement") {
				state = body ? flowStatement(body, head) : head;
				state = flowExpr(condition, join(state, target.continueState));
			} else {
				state = flowExpr(condition, head);
				state = body ? flowStatement(body, state) : state;
				state = flowExpr(increment, join(state, target.continueState));
			}
			targets.pop();
			return { end: state, target };
		};

		// Fixpoint over the WRAP-AROUND: the state one turn ends in is the state
		// the next turn starts in. Silent passes until the head is stable, then
		// ONE recording pass, so a violation is reported once, at the state the
		// loop really reaches.
		const outer = recording;
		recording = false;
		let head = entry;
		for (let pass = 0; pass < 4; pass++) {
			const next = join(entry, turn(head).end);
			if (next === head) break;
			head = next;
		}
		recording = outer;
		const { end, target } = turn(head);
		// The loop leaves at its head check, or through a `break`.
		return join(join(head, end), target.breakState);
	}

	// Every loop in the file, each from a settled start (what precedes a loop
	// is straight-line code, bounded by its length). A labelled loop keeps its
	// label: `continue outer;` from an inner loop must land on THIS loop's
	// continue state, or the pending region it carries is silently dropped.
	walk(root, (node) => {
		if (LOOP_TYPES.has(node.type)) {
			recording = true;
			targets.length = 0;
			const parent = node.parent;
			const label =
				parent?.type === "labeled_statement"
					? (parent.childForFieldName("label")?.text ?? null)
					: null;
			flowLoop(node, false, label);
		}
		return undefined;
	});

	return {
		violations: [...violations.values()],
		regionLoops: regionLoops.size,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Census and sweep
// ════════════════════════════════════════════════════════════════════════════

export interface RegionCensus {
	/** `withRegion(` calls. */
	regions: number;
	/** `.prepare(` / `.exec(` calls. */
	statements: number;
	/** Methods of the file that reach a region (SR-2's recogniser). */
	reachingMethods: number;
	/** Loops whose head, body or update reaches a region (SR-2's scope). */
	regionLoops: number;
	/** `await yieldToEventLoop();` statements in the file. */
	yieldStatements: number;
}

/**
 * What the sweep SAW: region calls, `.prepare(`/`.exec(` calls, and what SR-2
 * recognised. A clean result over a file with no statements would prove
 * nothing, so the caller asserts these are non-trivial alongside the empty
 * findings.
 */
export function regionCensus(source: string, parser: Parser): RegionCensus {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	let regions = 0;
	let statements = 0;
	let yieldStatements = 0;
	walk(tree.rootNode, (node) => {
		if (isYieldStatement(node)) yieldStatements++;
		if (node.type !== "call_expression") return undefined;
		const name = calleeName(node);
		if (name === "withRegion") regions++;
		else if (name === "prepare" || name === "exec") statements++;
		return undefined;
	});
	const reach = computeReach(tree.rootNode);
	return {
		regions,
		statements,
		reachingMethods: reach.methods.size,
		regionLoops: flowLoops(tree.rootNode, reach).regionLoops,
		yieldStatements,
	};
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
	const root = tree.rootNode;
	const reach = computeReach(root);

	const calls: Node[] = [];
	const preparedNames = new Set<string>();
	const regionMentions: Node[] = [];

	walk(root, (node) => {
		if (node.type === "call_expression") {
			calls.push(node);
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
		} else if (
			(node.type === "identifier" || node.type === "property_identifier") &&
			node.text === "withRegion"
		) {
			regionMentions.push(node);
		}
		return undefined;
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
					return undefined;
				});
				if (arg.text.trimStart().startsWith("async") || awaits) {
					findings.push(finding("SR-1c", arg));
				}
			}
		}

		// SR-2, iterator half: an array iterator runs its callback once per
		// element with no chance to yield between them.
		if (isRegionCall(call, reach) && insideIteratorCallback(call)) {
			findings.push(finding("SR-2", call));
		}
		// ...including a region-reaching function handed to one BY NAME.
		if (name !== null && ITERATOR_METHODS.has(name)) {
			const args = call.childForFieldName("arguments");
			for (const arg of args ? namedChildren(args) : []) {
				const a = unwrap(arg);
				const method = thisMethodName(a);
				if (
					(method !== null && reach.methods.has(method)) ||
					(a.type === "identifier" && reach.functions.has(a.text))
				) {
					findings.push(finding("SR-2", call));
				}
			}
		}
	}

	// SR-2, recogniser half: `withRegion` appears only as its own method's name
	// or a call's callee. An alias (`const w = this.withRegion.bind(this)`) or a
	// callback reference would open regions the flow walk cannot see.
	for (const mention of regionMentions) {
		const parent = mention.parent;
		if (parent?.type === "method_definition") continue;
		if (
			parent?.type === "call_expression" &&
			sameNode(parent.childForFieldName("function"), mention)
		) {
			continue;
		}
		if (
			parent?.type === "member_expression" &&
			parent.parent?.type === "call_expression" &&
			sameNode(parent.parent.childForFieldName("function"), parent)
		) {
			continue;
		}
		findings.push(finding("SR-2", parent ?? mention));
	}

	// SR-2, loop half: the flow walk.
	for (const call of flowLoops(root, reach).violations) {
		findings.push(finding("SR-2", call));
	}

	return findings.sort((a, b) => a.line - b.line);
}
