/**
 * THE CALLER-SIDE SR-2 SWEEP — the static half of V2.4, over
 * `src/core/indexer.ts`.
 *
 * `tracker.ts` bounds ONE region per call (`sync-region.ts`, THE ARITHMETIC).
 * The bound composes into a heartbeat bound only if the event loop reaches
 * its TIMERS phase between two regions. Inside `tracker.ts` that is swept by
 * `tracker-region-sweep.ts`, whose regions are literal `withRegion(` calls.
 * Here the regions are METHOD CALLS on the tracker, so this sweep must first
 * recognise which calls reach a region, then decide whether a yield separates
 * them.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Inside every loop (`for`/`for…of`/`for…in`/`while`/`do`) and every callback
 * handed to an array iterator (`map`, `filter`, `forEach`, …), no region-
 * reaching call may be reached while an earlier one is still PENDING — that
 * is, with no `await yieldToEventLoop();` statement executed since. The
 * analysis is a small data-flow walk, not a lexical "is there an await
 * between": it follows `if`/`else`, `try`/`catch`/`finally`, `continue`,
 * `break`, `return`, nested loops, and each loop's WRAP-AROUND to a fixpoint.
 * A yield inside one branch of an `if` does not settle the other branch.
 *
 * ── WHAT COUNTS AS A YIELD: ONE THING ───────────────────────────────────────
 * Only the statement `await yieldToEventLoop();`. NOT any `await`. Measured in
 * this repository (see the implementation log): the real
 * `extractSymbols`/`extractReferences` loop over 400 files ran 2 377 ms with
 * ZERO ticks of a 20 ms `setInterval`, because `parserManager.parse()`
 * resolves a cached parser and its `await` is a MICROTASK — the timers phase
 * never runs. `tracker-region-sweep.ts`'s SR-2 accepts any `await`, which is
 * unsound for exactly this reason. A conditional yield (`if (x) await …`) does
 * not settle the path that skips it, and is treated accordingly.
 *
 * ── WHAT COUNTS AS A REGION-REACHING CALL ───────────────────────────────────
 *   T1  a method call on a TRACKER HANDLE: `this.fileTracker` (with `!`/`?.`),
 *       a local alias of it, or a parameter typed `FileTracker`/`IFileTracker`;
 *   T2  a method call on a DERIVED HANDLE: a local or `this.` field assigned
 *       from a call/`new` that was handed a tracker handle, a derived handle
 *       or `this` (`createReferenceGraphManager(this.fileTracker!)`,
 *       `createEnricher(…, this.fileTracker)`), to a fixpoint;
 *   T3  any call that is HANDED a tracker handle, a derived handle or `this`;
 *   T4  `this.m(…)` where method `m` of this file reaches a region, and
 *       `f(…)` where local function `f` does — both to a fixpoint;
 *   T5  an array-iterator call whose callback reaches a region.
 * Every `this.fileTracker` occurrence must sit in a position the recogniser
 * understands (a call receiver, a call argument, an alias, its assignment, or
 * a truthiness test); anything else — a destructuring, a subscript, an
 * escape through a container — is itself a finding (`UNSUPPORTED`), so the
 * handle cannot leave the analysis silently.
 *
 * ── LIMITS, stated so nobody trusts more than this proves ──────────────────
 *   - INTRA-FILE. A module handed the tracker (the enricher, the reference
 *     graph, the repo-map generator, the invalidation walk) runs its own loops,
 *     which this sweep sees as ONE region-event at the call site, not inside.
 *     Those modules' loops are their own residue; V2.4's runtime measurement
 *     covers them only when they run under the lock.
 *   - STRAIGHT-LINE code outside any loop is not checked: a constant number of
 *     back-to-back regions is bounded by that count, and the rule exists for
 *     the N-fold case.
 *   - CONSERVATIVE on purpose: `a ? t.x() : t.y()` counts two regions, and an
 *     `async` helper that yields internally is not recognised as a yield. Both
 *     can only produce a false finding, never hide a real one.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

export type LoopRule = "SR-2-caller" | "UNSUPPORTED";

export interface LoopFinding {
	rule: LoopRule;
	/** 1-based. */
	line: number;
	/** First line of the offending call. */
	text: string;
	/** The class method the finding sits in, or `null` at module level. */
	method: string | null;
	/** The region-reaching callee's name (`markIndexed`, `extractSymbolGraph`). */
	callee: string | null;
}

/** A loop that may keep an unyielded shape, with the reason it is safe. */
export interface LoopAllowance {
	method: string;
	callee: string;
	reason: string;
}

export interface LoopCensus {
	/** Loops and iterator callbacks whose body reaches at least one region. */
	regionLoops: number;
	/** Distinct region-reaching calls inside those bodies. */
	regionCallsInLoops: number;
	/** Callee names of those calls, sorted and de-duplicated. */
	calleesInLoops: string[];
	/** `await yieldToEventLoop();` statements in the whole file. */
	yieldStatements: number;
}

export interface LoopSweepResult {
	findings: LoopFinding[];
	/** Findings an allowance matched. Reported so an allowance stays visible. */
	allowed: Array<LoopFinding & { reason: string }>;
	/** Allowances that matched nothing: stale, and a failure of their own. */
	unusedAllowances: LoopAllowance[];
	census: LoopCensus;
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

/** Array methods that invoke their callback per element, synchronously. */
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

const TRACKER_TYPE = /\bI?FileTracker\b/;

function namedChildren(node: Node): Node[] {
	const out: Node[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child) out.push(child);
	}
	return out;
}

function walk(node: Node, visit: (n: Node) => boolean | undefined): void {
	// `visit` returning false prunes the subtree.
	if (visit(node) === false) return;
	for (const child of namedChildren(node)) walk(child, visit);
}

/** Unwrap `x!`, `(x)`, `x as T`, `x satisfies T`, `await x`. */
function unwrap(node: Node): Node {
	let current = node;
	while (
		current.type === "non_null_expression" ||
		current.type === "parenthesized_expression" ||
		current.type === "as_expression" ||
		current.type === "satisfies_expression" ||
		current.type === "await_expression"
	) {
		const inner = current.namedChild(0);
		if (!inner) break;
		current = inner;
	}
	return current;
}

function isThisMember(node: Node, property?: string): boolean {
	const n = unwrap(node);
	if (n.type !== "member_expression") return false;
	const object = n.childForFieldName("object");
	const prop = n.childForFieldName("property");
	return (
		object?.type === "this" &&
		prop !== null &&
		(property === undefined || prop.text === property)
	);
}

function calleeName(call: Node): string | null {
	const fn = call.childForFieldName("function");
	if (!fn) return null;
	const f = unwrap(fn);
	if (f.type === "identifier") return f.text;
	if (f.type === "member_expression") {
		return f.childForFieldName("property")?.text ?? null;
	}
	return null;
}

function enclosingMethod(node: Node): string | null {
	for (let p = node.parent; p; p = p.parent) {
		if (p.type === "method_definition") {
			return p.childForFieldName("name")?.text ?? null;
		}
	}
	return null;
}

function firstLine(node: Node): string {
	return (node.text.split("\n")[0] ?? "").trim();
}

function isYieldStatement(stmt: Node): boolean {
	if (stmt.type !== "expression_statement") return false;
	const expr = stmt.namedChild(0);
	if (expr?.type !== "await_expression") return false;
	const call = expr.namedChild(0);
	return (
		call?.type === "call_expression" &&
		call.childForFieldName("function")?.type === "identifier" &&
		call.childForFieldName("function")?.text === "yieldToEventLoop" &&
		(call.childForFieldName("arguments")?.namedChildCount ?? 0) === 0
	);
}

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

/**
 * Sweep one source file (indexer.ts) for caller-side SR-2 violations.
 */
export function sweepIndexerLoops(
	source: string,
	parser: Parser,
	allowances: readonly LoopAllowance[] = [],
): LoopSweepResult {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	const root = tree.rootNode;

	// ── 1. Tracker handles and derived handles ──────────────────────────────
	const trackerAliases = new Set<string>();
	const derivedLocals = new Set<string>();
	const derivedFields = new Set<string>();
	const unsupported: LoopFinding[] = [];

	walk(root, (node) => {
		if (
			node.type === "required_parameter" ||
			node.type === "optional_parameter"
		) {
			const pattern = node.childForFieldName("pattern");
			const type = node.childForFieldName("type");
			if (
				pattern?.type === "identifier" &&
				type &&
				TRACKER_TYPE.test(type.text)
			) {
				trackerAliases.add(pattern.text);
			}
		}
		return undefined;
	});

	const isTrackerHandle = (node: Node): boolean => {
		const n = unwrap(node);
		if (isThisMember(n, "fileTracker")) return true;
		return n.type === "identifier" && trackerAliases.has(n.text);
	};
	const isDerivedHandle = (node: Node): boolean => {
		const n = unwrap(node);
		if (n.type === "identifier") return derivedLocals.has(n.text);
		if (isThisMember(n)) {
			const prop = unwrap(n).childForFieldName("property")?.text ?? "";
			return derivedFields.has(prop);
		}
		return false;
	};
	const isHandle = (node: Node): boolean =>
		isTrackerHandle(node) || isDerivedHandle(node);

	const handedAHandle = (valueNode: Node): boolean => {
		const v = unwrap(valueNode);
		if (v.type !== "call_expression" && v.type !== "new_expression") {
			return false;
		}
		const args = v.childForFieldName("arguments");
		return (args ? namedChildren(args) : []).some(
			(a) => isHandle(a) || unwrap(a).type === "this",
		);
	};

	// Aliases and derived handles, to a fixpoint (a derived handle can be
	// derived from another one).
	for (let changed = true; changed; ) {
		changed = false;
		walk(root, (node) => {
			let name: Node | null = null;
			let value: Node | null = null;
			if (node.type === "variable_declarator") {
				name = node.childForFieldName("name");
				value = node.childForFieldName("value");
			} else if (node.type === "assignment_expression") {
				name = node.childForFieldName("left");
				value = node.childForFieldName("right");
			}
			if (!name || !value) return undefined;
			if (name.type === "identifier") {
				if (isTrackerHandle(value) && !trackerAliases.has(name.text)) {
					trackerAliases.add(name.text);
					changed = true;
				} else if (handedAHandle(value) && !derivedLocals.has(name.text)) {
					derivedLocals.add(name.text);
					changed = true;
				}
			} else if (isThisMember(name) && handedAHandle(value)) {
				const prop = name.childForFieldName("property")?.text ?? "";
				if (prop !== "fileTracker" && !derivedFields.has(prop)) {
					derivedFields.add(prop);
					changed = true;
				}
			}
			return undefined;
		});
	}

	// Every `this.fileTracker` must be somewhere the recogniser understands.
	walk(root, (node) => {
		const text = node.text;
		if (
			(node.type === "property_identifier" ||
				node.type === "identifier" ||
				node.type === "shorthand_property_identifier_pattern") &&
			text === "fileTracker"
		) {
			const parent = node.parent;
			// `private fileTracker: …` — the declaration itself.
			if (parent?.type === "public_field_definition") return undefined;
			if (
				parent?.type === "member_expression" &&
				parent.childForFieldName("object")?.type === "this" &&
				trackerPositionOk(parent)
			) {
				return undefined;
			}
			unsupported.push({
				rule: "UNSUPPORTED",
				line: node.startPosition.row + 1,
				text: firstLine(parent ?? node),
				method: enclosingMethod(node),
				callee: null,
			});
		} else if (
			node.type === "subscript_expression" &&
			node.childForFieldName("object")?.type === "this"
		) {
			unsupported.push({
				rule: "UNSUPPORTED",
				line: node.startPosition.row + 1,
				text: firstLine(node),
				method: enclosingMethod(node),
				callee: null,
			});
		}
		return undefined;
	});

	/**
	 * `this.fileTracker` as a call receiver, a call argument, an alias's
	 * value, an assignment target, or a truthiness test. Anything else lets the
	 * handle escape the analysis.
	 */
	function trackerPositionOk(member: Node): boolean {
		let n = member;
		while (
			n.parent &&
			(n.parent.type === "non_null_expression" ||
				n.parent.type === "parenthesized_expression")
		) {
			n = n.parent;
		}
		const p = n.parent;
		if (!p) return false;
		switch (p.type) {
			case "member_expression":
				// receiver: `this.fileTracker.m` — must be the object, and called.
				return (
					p.childForFieldName("object")?.startIndex === n.startIndex &&
					p.parent?.type === "call_expression" &&
					p.parent.childForFieldName("function")?.startIndex === p.startIndex
				);
			case "arguments":
				return true;
			case "variable_declarator":
				return p.childForFieldName("value")?.startIndex === n.startIndex;
			case "assignment_expression":
				// `this.fileTracker = createFileTracker(…)` — the setter.
				return p.childForFieldName("left")?.startIndex === n.startIndex;
			case "binary_expression":
				// A truthiness or identity test, never arithmetic or concatenation.
				return ["&&", "||", "??", "!==", "===", "!=", "=="].includes(
					p.childForFieldName("operator")?.text ?? "",
				);
			case "unary_expression":
			case "if_statement":
			case "ternary_expression":
				return true;
			default:
				return false;
		}
	}

	// ── 2. Functions and methods that reach a region, to a fixpoint ─────────
	const methodBodies = new Map<string, Node[]>();
	const localFunctions = new Map<string, Node[]>();
	walk(root, (node) => {
		if (node.type === "method_definition") {
			const name = node.childForFieldName("name")?.text;
			if (name) {
				const list = methodBodies.get(name) ?? [];
				list.push(node);
				methodBodies.set(name, list);
			}
		} else if (node.type === "function_declaration") {
			const name = node.childForFieldName("name")?.text;
			if (name) {
				const list = localFunctions.get(name) ?? [];
				list.push(node);
				localFunctions.set(name, list);
			}
		} else if (node.type === "variable_declarator") {
			const name = node.childForFieldName("name");
			const value = node.childForFieldName("value");
			if (
				name?.type === "identifier" &&
				value &&
				FUNCTION_TYPES.has(value.type)
			) {
				const list = localFunctions.get(name.text) ?? [];
				list.push(value);
				localFunctions.set(name.text, list);
			}
		}
		return undefined;
	});

	const reachingMethods = new Set<string>();
	const reachingFunctions = new Set<string>();

	/** Is `fn` (a function node) an array-iterator callback that reaches? */
	function callbackReaches(arg: Node): boolean {
		const a = unwrap(arg);
		if (FUNCTION_TYPES.has(a.type)) return bodyReaches(a);
		return a.type === "identifier" && reachingFunctions.has(a.text);
	}

	function isRegionCall(call: Node): boolean {
		const fn = call.childForFieldName("function");
		if (!fn) return false;
		const f = unwrap(fn);
		const args = call.childForFieldName("arguments");
		const argList = args ? namedChildren(args) : [];
		if (f.type === "member_expression") {
			const object = f.childForFieldName("object");
			const prop = f.childForFieldName("property")?.text ?? "";
			if (object && isHandle(object)) return true; // T1, T2
			if (object?.type === "this" && reachingMethods.has(prop)) return true; // T4
			if (ITERATOR_METHODS.has(prop) && argList.some(callbackReaches)) {
				return true; // T5
			}
		} else if (f.type === "identifier" && reachingFunctions.has(f.text)) {
			return true; // T4
		}
		// T3: handed a handle, or `this`.
		return argList.some((a) => isHandle(a) || unwrap(a).type === "this");
	}

	/** Region calls inside `node`, not descending into nested functions. */
	function regionCallsIn(node: Node): Node[] {
		const out: Node[] = [];
		walk(node, (n) => {
			if (n !== node && FUNCTION_TYPES.has(n.type)) return false;
			if (n.type === "call_expression" && isRegionCall(n)) out.push(n);
			return undefined;
		});
		return out.sort((a, b) => a.startIndex - b.startIndex);
	}

	function bodyReaches(fn: Node): boolean {
		const body = fn.childForFieldName("body");
		return body !== null && regionCallsIn(body).length > 0;
	}

	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, nodes] of methodBodies) {
			if (!reachingMethods.has(name) && nodes.some(bodyReaches)) {
				reachingMethods.add(name);
				changed = true;
			}
		}
		for (const [name, nodes] of localFunctions) {
			if (!reachingFunctions.has(name) && nodes.some(bodyReaches)) {
				reachingFunctions.add(name);
				changed = true;
			}
		}
	}

	// ── 3. The flow walk ────────────────────────────────────────────────────
	const violations = new Map<number, Node>();
	const callsInLoops = new Map<number, Node>();
	const regionLoopNodes = new Set<number>();
	let recording = true;
	const targets: JumpTarget[] = [];

	function flowExpr(node: Node | null, s: State): State {
		if (!node || s === null) return s;
		let state = s;
		for (const call of regionCallsIn(node)) {
			callsInLoops.set(call.startIndex, call);
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
					const stmts = namedChildren(c).filter(
						(x) => x.startIndex !== c.childForFieldName("value")?.startIndex,
					);
					fall = flowList(stmts, join(value, fall));
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
		if (reaches > 0) regionLoopNodes.add(loop.startIndex);

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

	/**
	 * An array-iterator callback is a loop body with no yield between two
	 * elements: the iterator calls the next element straight after the last
	 * one returns. A SYNC callback cannot yield at all. An ASYNC one runs
	 * synchronously up to its first real yield, and two invocations' regions
	 * can land in one turn of the event loop — so both START PENDING.
	 */
	function flowCallback(fn: Node): void {
		const body = fn.childForFieldName("body");
		if (!body || regionCallsIn(body).length === 0) return;
		regionLoopNodes.add(fn.startIndex);
		targets.length = 0;
		recording = true;
		if (body.type === "statement_block") flowStatement(body, true);
		else flowExpr(body, true);
	}

	// Every loop in the file, each from a settled start (what precedes a loop
	// is straight-line code, bounded by its length).
	walk(root, (node) => {
		if (LOOP_TYPES.has(node.type)) {
			recording = true;
			targets.length = 0;
			flowLoop(node, false, null);
		}
		return undefined;
	});
	// Every array-iterator callback that reaches a region.
	walk(root, (node) => {
		if (node.type !== "call_expression") return undefined;
		const fn = node.childForFieldName("function");
		const f = fn ? unwrap(fn) : null;
		if (f?.type !== "member_expression") return undefined;
		const prop = f.childForFieldName("property")?.text ?? "";
		if (!ITERATOR_METHODS.has(prop)) return undefined;
		const args = node.childForFieldName("arguments");
		for (const arg of args ? namedChildren(args) : []) {
			const a = unwrap(arg);
			if (FUNCTION_TYPES.has(a.type)) flowCallback(a);
			else if (a.type === "identifier" && reachingFunctions.has(a.text)) {
				for (const def of localFunctions.get(a.text) ?? []) flowCallback(def);
			}
		}
		return undefined;
	});

	// ── 4. Findings, allowances, census ─────────────────────────────────────
	const raw: LoopFinding[] = [
		...unsupported,
		...[...violations.values()].map((call) => ({
			rule: "SR-2-caller" as const,
			line: call.startPosition.row + 1,
			text: firstLine(call),
			method: enclosingMethod(call),
			callee: calleeName(call),
		})),
	];
	const findings: LoopFinding[] = [];
	const allowed: Array<LoopFinding & { reason: string }> = [];
	const used = new Set<LoopAllowance>();
	for (const f of raw) {
		const allowance =
			f.rule === "SR-2-caller"
				? allowances.find((a) => a.method === f.method && a.callee === f.callee)
				: undefined;
		if (allowance) {
			used.add(allowance);
			allowed.push({ ...f, reason: allowance.reason });
		} else {
			findings.push(f);
		}
	}

	let yieldStatements = 0;
	walk(root, (node) => {
		if (isYieldStatement(node)) yieldStatements++;
		return undefined;
	});

	return {
		findings: findings.sort((a, b) => a.line - b.line),
		allowed,
		unusedAllowances: allowances.filter((a) => !used.has(a)),
		census: {
			regionLoops: regionLoopNodes.size,
			regionCallsInLoops: callsInLoops.size,
			calleesInLoops: [
				...new Set(
					[...callsInLoops.values()]
						.map(calleeName)
						.filter((n): n is string => n !== null),
				),
			].sort(),
			yieldStatements,
		},
	};
}
