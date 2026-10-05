/**
 * S-Y — THE OVERLAY YIELD SWEEP (step 3, NFR-5; CLAUDE.md #31, SR-2).
 *
 * The dirty overlay runs on the search path, and an MCP server can be holding
 * the store lock (and its 1 s heartbeat timer) in the same process. Every loop
 * that does WORK — awaits something, or touches the filesystem, the tracker or
 * the parser — must return to the event loop's timers phase between
 * iterations, or the heartbeat starves (CLAUDE.md #27's mechanism).
 *
 * ── THE RULES, per loop in `src/core/overlay/**` ────────────────────────────
 *   SY-no-yield   a work loop whose body does not END with
 *                 `await <…>.yieldIfDue()` or `await yieldToEventLoop()`.
 *   SY-continue   a work loop with a `continue` of its own: a `continue` skips
 *                 the trailing yield.
 *   SY-fake-clock a `yieldIfDue` method that never calls `yieldToEventLoop()`
 *                 — it would satisfy the rule above and yield nothing.
 *
 * A loop is a WORK loop when its body, outside nested functions, contains an
 * `await` or a call to one of `WORK_CALLS`. Pure in-memory loops (building a
 * Set, mapping rows) are exempt; their cost is bounded by the data the work
 * loops already sliced.
 *
 * ── SIGHT (CLAUDE.md #32) ──────────────────────────────────────────────────
 * Real tree-sitter parse, and a census: lines covered against the files' real
 * length, ERROR/MISSING nodes, loops seen, work loops seen. The test asserts
 * the census and plants violations before it trusts silence.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

/** Synchronous work: filesystem, hashing, parsing, tracker regions. */
export const WORK_CALLS: ReadonlySet<string> = new Set([
	"readFileSync",
	"statSync",
	"lstatSync",
	"existsSync",
	"hashFileBytes",
	"isSelectedFile",
	"diskStateOf",
	"chunkFileByPath",
	"getIndexedFileStates",
	"getFilesIndexedSince",
	"getIndexedHighWater",
	"readOverlayManifest",
	"writeOverlayManifest",
	"wipeOverlayData",
]);

const YIELD_CALLS: ReadonlySet<string> = new Set([
	"yieldIfDue",
	"yieldToEventLoop",
]);

const LOOP_TYPES = new Set([
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
]);

const FUNCTION_TYPES = new Set([
	"arrow_function",
	"function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

export type YieldRule = "SY-no-yield" | "SY-continue" | "SY-fake-clock";

export interface YieldFinding {
	rule: YieldRule;
	file: string;
	line: number;
	text: string;
}

export interface YieldCensus {
	files: number;
	fileLines: number;
	linesScanned: number;
	parseErrors: number;
	loops: number;
	workLoops: number;
	clocks: number;
}

export interface YieldSweepResult {
	findings: YieldFinding[];
	census: YieldCensus;
}

function children(node: Node): Node[] {
	const out: Node[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) out.push(child);
	}
	return out;
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (const child of children(node)) walk(child, visit);
}

/** Walk `node`'s subtree WITHOUT entering nested functions (or nested loops when asked). */
function walkOwn(
	node: Node,
	visit: (n: Node) => void,
	stopAtLoops: boolean,
): void {
	for (const child of children(node)) {
		if (FUNCTION_TYPES.has(child.type)) continue;
		visit(child);
		if (stopAtLoops && LOOP_TYPES.has(child.type)) continue;
		walkOwn(child, visit, stopAtLoops);
	}
}

function calleeName(call: Node): string | null {
	const fn = call.childForFieldName("function");
	if (!fn) return null;
	if (fn.type === "identifier") return fn.text;
	if (fn.type === "member_expression") {
		return fn.childForFieldName("property")?.text ?? null;
	}
	return null;
}

function isWorkLoop(body: Node): boolean {
	let work = false;
	walkOwn(
		body,
		(n) => {
			if (n.type === "await_expression") work = true;
			if (n.type === "call_expression") {
				const name = calleeName(n);
				if (name !== null && WORK_CALLS.has(name)) work = true;
			}
		},
		false,
	);
	return work;
}

/** The statement a loop body ends with: the last named child of a block. */
function lastStatement(body: Node): Node | null {
	if (body.type !== "statement_block") return body;
	const named: Node[] = [];
	for (let i = 0; i < body.namedChildCount; i++) {
		const child = body.namedChild(i);
		if (child && child.type !== "comment") named.push(child);
	}
	return named[named.length - 1] ?? null;
}

function isYieldStatement(stmt: Node | null): boolean {
	if (stmt === null || stmt.type !== "expression_statement") return false;
	const expr = stmt.namedChild(0);
	if (expr?.type !== "await_expression") return false;
	const call = expr.namedChild(0);
	if (call?.type !== "call_expression") return false;
	const name = calleeName(call);
	return name !== null && YIELD_CALLS.has(name);
}

function loopBody(loop: Node): Node | null {
	return loop.childForFieldName("body");
}

export interface SweepFile {
	path: string;
	source: string;
}

export function sweepOverlayYields(
	files: readonly SweepFile[],
	parser: Parser,
): YieldSweepResult {
	const findings: YieldFinding[] = [];
	const census: YieldCensus = {
		files: 0,
		fileLines: 0,
		linesScanned: 0,
		parseErrors: 0,
		loops: 0,
		workLoops: 0,
		clocks: 0,
	};
	for (const file of files) {
		const tree = parser.parse(file.source);
		if (!tree) throw new Error(`parse failed: ${file.path}`);
		const root = tree.rootNode;
		census.files++;
		const lines = file.source.split("\n").length;
		census.fileLines += lines;
		census.linesScanned += Math.min(lines, root.endPosition.row + 1);
		walk(root, (node) => {
			if (node.type === "ERROR" || node.isMissing) census.parseErrors++;
			if (
				node.type === "method_definition" &&
				node.childForFieldName("name")?.text === "yieldIfDue"
			) {
				census.clocks++;
				let yields = false;
				walk(node, (n) => {
					if (
						n.type === "call_expression" &&
						calleeName(n) === "yieldToEventLoop"
					) {
						yields = true;
					}
				});
				if (!yields) {
					findings.push({
						rule: "SY-fake-clock",
						file: file.path,
						line: node.startPosition.row + 1,
						text: "yieldIfDue",
					});
				}
			}
			if (!LOOP_TYPES.has(node.type)) return;
			census.loops++;
			const body = loopBody(node);
			if (body === null || !isWorkLoop(body)) return;
			census.workLoops++;
			const line = node.startPosition.row + 1;
			const head = node.text.split("\n")[0]?.trim() ?? "";
			if (!isYieldStatement(lastStatement(body))) {
				findings.push({
					rule: "SY-no-yield",
					file: file.path,
					line,
					text: head,
				});
			}
			let ownContinue = false;
			walkOwn(
				body,
				(n) => {
					if (n.type === "continue_statement") ownContinue = true;
				},
				true,
			);
			if (ownContinue) {
				findings.push({
					rule: "SY-continue",
					file: file.path,
					line,
					text: head,
				});
			}
		});
		tree.delete();
	}
	return { findings, census };
}
