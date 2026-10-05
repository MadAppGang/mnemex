/**
 * O4-2 — THE GAP-WRITER SWEEP over `src/core/overlay/dirty-overlay.ts`
 * (iteration 2, O4).
 *
 * `OverlayReport.gaps` is a closed set of machine tokens and its free text
 * lives in `gapDetails`. Both are written by ONE class, `GapRecorder`, whose
 * `noteGap(token, …)` takes an `OverlayGapToken` — so the type system pins
 * every token that goes through it. What the type system cannot pin is a write
 * that goes AROUND it: a raw `gaps.push(\`…\`)` into some string array, or a
 * hand-built `gaps: [...]` literal in a report object. Those are what put
 * prose and provider JSON into `overlay_gaps` before.
 *
 * Rules, outside `class GapRecorder`:
 *   raw-push     a `.push(…)` call on a receiver whose last property is named
 *                like a gap list (`gaps`, `passGaps`, `gapDetails`, …)
 *   raw-literal  an object-literal property keyed `gaps` or `gapDetails`
 *
 * CLAUDE.md #32: tree-sitter, not a hand-rolled stripper, and a census —
 * lines the parse tree covers against the file's real length, ERROR/MISSING
 * nodes, call expressions and object pairs scanned — that the test asserts
 * before trusting an empty findings list.
 *
 * It reads source and executes none.
 */

import type { Node, Parser } from "web-tree-sitter";

export const GAP_WRITER_CLASS = "GapRecorder";

const GAP_LIST_NAME = /gap/i;
const GAP_FIELD_KEYS = new Set(["gaps", "gapDetails"]);

export type GapRule = "raw-push" | "raw-literal";

export interface GapFinding {
	readonly rule: GapRule;
	/** 1-based line. */
	readonly line: number;
	readonly text: string;
}

export interface GapSweepResult {
	readonly findings: readonly GapFinding[];
	readonly census: {
		readonly fileLines: number;
		readonly linesCovered: number;
		readonly parseErrors: number;
		readonly callsScanned: number;
		readonly pairsScanned: number;
		/** `noteGap(` calls outside the recorder: the sanctioned writes. */
		readonly noteGapCalls: number;
	};
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walk(child, visit);
	}
}

function insideRecorder(node: Node): boolean {
	let cur = node.parent;
	while (cur) {
		if (
			cur.type === "class_declaration" &&
			cur.childForFieldName("name")?.text === GAP_WRITER_CLASS
		) {
			return true;
		}
		cur = cur.parent;
	}
	return false;
}

function countLines(source: string): number {
	if (source.length === 0) return 0;
	const lines = source.split("\n").length;
	return source.endsWith("\n") ? lines - 1 : lines;
}

/** The last property name of a member-expression receiver, or the identifier. */
function receiverName(node: Node | null): string | null {
	if (!node) return null;
	if (node.type === "identifier") return node.text;
	if (node.type === "member_expression") {
		return node.childForFieldName("property")?.text ?? null;
	}
	return null;
}

export function sweepOverlayGaps(
	source: string,
	parser: Parser,
): GapSweepResult {
	const tree = parser.parse(source);
	if (!tree) throw new Error("tree-sitter returned no tree");
	const root = tree.rootNode;

	let parseErrors = 0;
	let callsScanned = 0;
	let pairsScanned = 0;
	let noteGapCalls = 0;
	const findings: GapFinding[] = [];
	const firstLine = (n: Node) => n.text.split("\n")[0] ?? "";

	walk(root, (n) => {
		if (n.type === "ERROR" || n.isMissing) parseErrors++;
		if (n.type === "call_expression") {
			callsScanned++;
			const fn = n.childForFieldName("function");
			if (fn?.type !== "member_expression") return;
			const method = fn.childForFieldName("property")?.text;
			if (method === "noteGap" && !insideRecorder(n)) noteGapCalls++;
			if (method !== "push") return;
			const target = receiverName(fn.childForFieldName("object"));
			if (target === null || !GAP_LIST_NAME.test(target)) return;
			if (insideRecorder(n)) return;
			findings.push({
				rule: "raw-push",
				line: n.startPosition.row + 1,
				text: firstLine(n),
			});
			return;
		}
		if (n.type === "pair") {
			pairsScanned++;
			const key = n.childForFieldName("key");
			const name = key?.text.replace(/^["']|["']$/g, "");
			if (name === undefined || !GAP_FIELD_KEYS.has(name)) return;
			if (insideRecorder(n)) return;
			findings.push({
				rule: "raw-literal",
				line: n.startPosition.row + 1,
				text: firstLine(n),
			});
		}
	});

	const covered = root.endPosition.row + (root.endPosition.column > 0 ? 1 : 0);
	return {
		findings,
		census: {
			fileLines: countLines(source),
			linesCovered: covered,
			parseErrors,
			callsScanned,
			pairsScanned,
			noteGapCalls,
		},
	};
}
