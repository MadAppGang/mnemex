/**
 * MCP `search`'s half of the overlay contract (step 3, phase 6; revision 1,
 * HIGH 7):
 *
 *   - `SemanticBackend` calls `searchScoped` — the only call that returns the
 *     overlay report — and hands the report to its per-request `onScoped` sink;
 *   - an overlay row leaves the backend as `source: "dirty"`, and only an
 *     overlay row does (a cloud `"cloud"`/`"overlay"` value never does);
 *   - `rrfMerge` and `tm2c2Merge` keep `source` when the dirty row is fused
 *     with another backend's hit at the same anchor, in EITHER order.
 */

import { describe, expect, test } from "bun:test";
import { SemanticBackend } from "../../../src/retrieval/backends/semantic.js";
import { DEFAULT_PIPELINE_CONFIG } from "../../../src/retrieval/pipeline/config.js";
import { rrfMerge, tm2c2Merge } from "../../../src/retrieval/pipeline/merge.js";
import type { BackendResult } from "../../../src/retrieval/pipeline/types.js";
import type { QueryClassification, SearchResult } from "../../../src/types.js";
import { stubOverlayReport } from "../../helpers/overlay-report-stub.js";

const CLASSIFICATION: QueryClassification = {
	intent: "semantic",
	confidence: 0.9,
	entities: [],
	reasoning: "test",
};

function result(
	id: string,
	file: string,
	startLine: number,
	source?: SearchResult["source"],
): SearchResult {
	return {
		chunk: {
			id,
			content: `function ${id}() {}`,
			filePath: file,
			startLine,
			endLine: startLine + 3,
			language: "typescript",
			chunkType: "function",
			name: id,
			fileHash: "h",
		},
		score: 0.8,
		vectorScore: 0.8,
		keywordScore: 0,
		...(source ? { source } : {}),
	};
}

describe("SemanticBackend -> searchScoped, with the overlay sink", () => {
	test("the report reaches onScoped; source survives only for dirty rows", async () => {
		const report = stubOverlayReport({
			state: "on",
			reason: "dirty",
			files: 1,
			suppressedRows: 4,
		});
		let calls = 0;
		const sunk: unknown[] = [];
		const backend = new SemanticBackend(
			() => ({
				searchScoped: async () => {
					calls++;
					return {
						results: [
							result("dirtyRow", "/w/src/a.ts", 1, "dirty"),
							result("indexRow", "/w/src/b.ts", 1),
							result("cloudRow", "/w/src/c.ts", 1, "cloud"),
						],
						branchUnknown: true,
						branchLabel: "main",
						branchEmpty: false,
						storeRebuiltElsewhere: false,
						penalty: { lookups: 0, sameFile: 0, applied: 0, labelled: 0 },
						overlay: report,
					};
				},
				close: async () => {},
			}),
			{ onScoped: (s) => sunk.push(s) },
		);
		const rows = await backend.search(
			"q",
			CLASSIFICATION,
			{ limit: 10 },
			new AbortController().signal,
		);
		expect(calls).toBe(1);
		expect(sunk).toEqual([{ overlay: report, branchUnknown: true }]);
		expect(rows.map((r) => [r.id, r.source])).toEqual([
			["dirtyRow", "dirty"],
			["indexRow", undefined],
			["cloudRow", undefined],
		]);
	});

	test("aborted while searching: no rows AND no report (review 1, LOW 9c)", async () => {
		const controller = new AbortController();
		const sunk: unknown[] = [];
		const backend = new SemanticBackend(
			() => ({
				searchScoped: async () => {
					// LSP short-circuits the pipeline while this search runs.
					controller.abort();
					return {
						results: [result("dirtyRow", "/w/src/a.ts", 1, "dirty")],
						branchUnknown: false,
						branchLabel: null,
						branchEmpty: false,
						storeRebuiltElsewhere: false,
						penalty: { lookups: 0, sameFile: 0, applied: 0, labelled: 0 },
						overlay: stubOverlayReport({ state: "on", files: 1 }),
					};
				},
				close: async () => {},
			}),
			{ onScoped: (s) => sunk.push(s) },
		);
		const rows = await backend.search(
			"q",
			CLASSIFICATION,
			{ limit: 10 },
			controller.signal,
		);
		expect(rows).toEqual([]);
		// A report of `on, files: 1` beside zero dirty rows would contradict itself.
		expect(sunk).toEqual([]);
	});

	test("no sink given: still searches (the hook is optional)", async () => {
		const backend = new SemanticBackend(() => ({
			searchScoped: async () => ({
				results: [result("indexRow", "/w/src/b.ts", 1)],
				branchUnknown: false,
				branchLabel: null,
				branchEmpty: false,
				storeRebuiltElsewhere: false,
				penalty: { lookups: 0, sameFile: 0, applied: 0, labelled: 0 },
				overlay: stubOverlayReport(),
			}),
			close: async () => {},
		}));
		const rows = await backend.search(
			"q",
			CLASSIFICATION,
			{},
			new AbortController().signal,
		);
		expect(rows).toHaveLength(1);
	});
});

describe("pipeline merge keeps `source` through fusion", () => {
	const dirty: BackendResult = {
		id: "d",
		file: "/w/src/a.ts",
		startLine: 10,
		snippet: "x",
		score: 0.9,
		backend: "semantic",
		source: "dirty",
	};
	const graphHit: BackendResult = {
		file: "/w/src/a.ts",
		startLine: 10,
		snippet: "x",
		score: 0.7,
		backend: "symbol-graph",
		symbol: "f",
	};
	const other: BackendResult = {
		file: "/w/src/z.ts",
		startLine: 1,
		snippet: "z",
		score: 0.5,
		backend: "symbol-graph",
	};

	for (const [label, merge] of [
		["rrfMerge", rrfMerge],
		["tm2c2Merge", tm2c2Merge],
	] as const) {
		test(`${label}: dirty row first, or fused INTO an earlier hit, stays dirty`, () => {
			const first = merge(
				[
					{ name: "semantic", results: [dirty] },
					{ name: "symbol-graph", results: [graphHit, other] },
				],
				DEFAULT_PIPELINE_CONFIG,
				10,
			);
			const second = merge(
				[
					{ name: "symbol-graph", results: [graphHit, other] },
					{ name: "semantic", results: [dirty] },
				],
				DEFAULT_PIPELINE_CONFIG,
				10,
			);
			for (const merged of [first, second]) {
				const fused = merged.find((r) => r.file === "/w/src/a.ts");
				expect(fused?.backends.sort()).toEqual(["semantic", "symbol-graph"]);
				expect(fused?.source).toBe("dirty");
				expect(merged.find((r) => r.file === "/w/src/z.ts")?.source).toBe(
					undefined,
				);
			}
		});
	}
});
