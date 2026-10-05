/**
 * R2 (D-TWIN) — the PURE half: `collapseSpanTwins` and `codeSpanKey`.
 *
 * The integration half, through a real LanceDB store and all three ranked
 * paths, is `span-twin-collapse.test.ts`. This file pins the rule itself:
 *
 *   - one result slot per code span; the FIRST occurrence in the fused order
 *     wins, which is the higher-ranked twin after fusion;
 *   - the walk covers the whole fused list, so a freed slot is back-filled
 *     and the list is short only when fewer than `limit` distinct spans exist;
 *   - rows that are not code (`session_observation`, summaries, docs types)
 *     never collapse;
 *   - every dropped twin of a KEPT row is recorded against it, so hydration
 *     can carry a summary over from it.
 */

import { describe, expect, test } from "bun:test";
import { codeSpanKey, collapseSpanTwins } from "../../../src/core/store.js";

interface Row {
	id: string;
	documentType?: string;
	path: string;
	startLine: number;
	endLine: number;
}

const row = (
	id: string,
	path: string,
	startLine: number,
	endLine: number,
	documentType?: string,
): Row => ({ id, path, startLine, endLine, documentType });

const keyOf = (r: Row) => codeSpanKey(r, r.path);

describe("codeSpanKey", () => {
	test("a code_chunk and a code_unit over one output path and span share ONE key (T-6, pure)", () => {
		const chunk = row("c", "/repo/src/a.ts", 3, 9, "code_chunk");
		const unit = row("u", "/repo/src/a.ts", 3, 9, "code_unit");
		expect(keyOf(chunk)).not.toBeNull();
		expect(keyOf(chunk)).toBe(keyOf(unit));
	});

	test("a missing documentType is a code_chunk (the store's own default)", () => {
		expect(keyOf(row("x", "/r/a.ts", 1, 2))).toBe(
			keyOf(row("y", "/r/a.ts", 1, 2, "code_chunk")),
		);
	});

	test("path, start and end each separate spans", () => {
		const base = keyOf(row("a", "/r/a.ts", 1, 5, "code_chunk"));
		expect(keyOf(row("b", "/r/b.ts", 1, 5, "code_chunk"))).not.toBe(base);
		expect(keyOf(row("c", "/r/a.ts", 2, 5, "code_chunk"))).not.toBe(base);
		expect(keyOf(row("d", "/r/a.ts", 1, 6, "code_chunk"))).not.toBe(base);
	});

	test("the separator cannot be forged by a path: `a.ts` + 12 is not `a.ts1` + 2", () => {
		expect(keyOf(row("a", "/r/a.ts", 12, 20))).not.toBe(
			keyOf(row("b", "/r/a.ts1", 2, 20)),
		);
	});

	test("non-code document types have NO key, so they never collapse", () => {
		for (const type of [
			"session_observation",
			"symbol_summary",
			"file_summary",
			"idiom",
			"framework_doc",
		]) {
			expect(keyOf(row("x", "/r/a.ts", 1, 2, type))).toBeNull();
		}
	});
});

describe("collapseSpanTwins", () => {
	test("one slot per span, first occurrence wins, freed slots back-filled (A)", () => {
		const fused = [
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
			row("u1", "/r/a.ts", 1, 5, "code_unit"),
			row("c2", "/r/b.ts", 1, 5, "code_chunk"),
			row("u2", "/r/b.ts", 1, 5, "code_unit"),
			row("c3", "/r/c.ts", 1, 5, "code_chunk"),
			row("c4", "/r/d.ts", 1, 5, "code_chunk"),
		];
		const { kept, twinIdsOf, collapsed } = collapseSpanTwins(fused, 4, keyOf);
		expect(kept.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4"]);
		expect(kept).toHaveLength(4);
		expect(twinIdsOf.get("c1")).toEqual(["u1"]);
		expect(twinIdsOf.get("c2")).toEqual(["u2"]);
		expect(twinIdsOf.has("c3")).toBe(false);
		expect(collapsed).toBe(2);
	});

	test("the higher-ranked twin is kept whichever TYPE it is", () => {
		const fused = [
			row("u1", "/r/a.ts", 1, 5, "code_unit"),
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
		];
		const { kept, twinIdsOf } = collapseSpanTwins(fused, 10, keyOf);
		expect(kept.map((r) => r.id)).toEqual(["u1"]);
		expect(twinIdsOf.get("u1")).toEqual(["c1"]);
	});

	test("short only when fewer than `limit` distinct spans exist", () => {
		const fused = [
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
			row("u1", "/r/a.ts", 1, 5, "code_unit"),
			row("c2", "/r/b.ts", 1, 5, "code_chunk"),
		];
		expect(collapseSpanTwins(fused, 5, keyOf).kept.map((r) => r.id)).toEqual([
			"c1",
			"c2",
		]);
	});

	test("twins BELOW the cut are still recorded against a kept row", () => {
		// The walk is the whole fused list, not the first `limit` rows, so a
		// lower-ranked twin's summary can still be carried over.
		const fused = [
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
			row("c2", "/r/b.ts", 1, 5, "code_chunk"),
			row("c3", "/r/c.ts", 1, 5, "code_chunk"),
			row("u1", "/r/a.ts", 1, 5, "code_unit"),
		];
		const { kept, twinIdsOf } = collapseSpanTwins(fused, 2, keyOf);
		expect(kept.map((r) => r.id)).toEqual(["c1", "c2"]);
		expect(twinIdsOf.get("c1")).toEqual(["u1"]);
	});

	test("a twin of a row that did NOT make the cut is not recorded", () => {
		const fused = [
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
			row("c2", "/r/b.ts", 1, 5, "code_chunk"),
			row("u2", "/r/b.ts", 1, 5, "code_unit"),
		];
		const { kept, twinIdsOf, collapsed } = collapseSpanTwins(fused, 1, keyOf);
		expect(kept.map((r) => r.id)).toEqual(["c1"]);
		expect(twinIdsOf.size).toBe(0);
		expect(collapsed).toBe(0);
	});

	test("non-code rows at one path and span are ALL kept", () => {
		const fused = [
			row("o1", "src/a.ts", 0, 0, "session_observation"),
			row("o2", "src/a.ts", 0, 0, "session_observation"),
			row("s1", "src/a.ts", 0, 0, "symbol_summary"),
		];
		expect(collapseSpanTwins(fused, 10, keyOf).kept).toHaveLength(3);
	});

	test("more than two rows on one span collapse to one (multi-revision superset)", () => {
		const fused = [
			row("u-rev2", "/r/a.ts", 1, 5, "code_unit"),
			row("u-rev1", "/r/a.ts", 1, 5, "code_unit"),
			row("c-rev1", "/r/a.ts", 1, 5, "code_chunk"),
			row("c2", "/r/b.ts", 1, 5, "code_chunk"),
		];
		const { kept, twinIdsOf, collapsed } = collapseSpanTwins(fused, 10, keyOf);
		expect(kept.map((r) => r.id)).toEqual(["u-rev2", "c2"]);
		expect(twinIdsOf.get("u-rev2")).toEqual(["u-rev1", "c-rev1"]);
		expect(collapsed).toBe(2);
	});

	test("limit 0 keeps nothing; the input is not mutated", () => {
		const fused = [
			row("c1", "/r/a.ts", 1, 5, "code_chunk"),
			row("u1", "/r/a.ts", 1, 5, "code_unit"),
		];
		const before = fused.map((r) => r.id);
		expect(collapseSpanTwins(fused, 0, keyOf).kept).toEqual([]);
		collapseSpanTwins(fused, 10, keyOf);
		expect(fused.map((r) => r.id)).toEqual(before);
	});
});
