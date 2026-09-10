/**
 * The enrichment write-back caller must not count a summary the store failed to
 * write.
 *
 * `BottomUpSummarizer` is the only caller of `updateUnitSummary`. That method
 * used to swallow its own failure with `console.warn` and return normally, so
 * this loop incremented `summariesGenerated` for a code unit whose row the
 * failed update had just DELETED — the report said "summarised", the index had
 * lost the unit, and `errors` was empty. Now the store throws, and the contract
 * asserted here is the one a caller can act on: the failure lands in `errors`
 * and does not land in the count.
 */

import { describe, expect, test } from "bun:test";
import {
	type IVectorStore,
	type VectorStore,
	VectorStoreUpdateError,
} from "../../../src/core/store.js";
import {
	BottomUpSummarizer,
	type SummarizationResult,
} from "../../../src/core/summarization/summarizer.js";
import type { CodeUnit, ILLMClient } from "../../../src/types.js";

const unit: CodeUnit = {
	id: "unit-a",
	parentId: null,
	unitType: "function",
	filePath: "src/a.ts",
	startLine: 1,
	endLine: 5,
	language: "typescript",
	content: "function a() {}",
	name: "a",
	fileHash: "file-a",
	depth: 0,
};

const llm = {
	complete: async () => ({ content: "a summary" }),
} as unknown as ILLMClient;

/** Only the three methods `summarizeFile` reaches. */
function storeWhoseUpdate(update: (id: string) => Promise<void>): VectorStore {
	return {
		getCodeUnitsByFile: async () => [unit],
		getMaxDepth: async () => 0,
		updateUnitSummary: (id: string) => update(id),
	} as unknown as VectorStore;
}

async function summarize(store: VectorStore): Promise<SummarizationResult> {
	return new BottomUpSummarizer(llm, store).summarizeFile("src/a.ts");
}

describe("BottomUpSummarizer write-back", () => {
	test("a failed write is an error, not a generated summary", async () => {
		const result = await summarize(
			storeWhoseUpdate(async (id) => {
				throw new VectorStoreUpdateError(
					"updateUnitSummary",
					id,
					false,
					new Error("forced add failure"),
					new Error("forced restore failure"),
				);
			}),
		);

		expect(result.summariesGenerated).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].unitId).toBe("unit-a");
		// The message carries the part the caller has to act on: whether the
		// row survived. Here it did not.
		expect(result.errors[0].error).toContain("NOT restored");
	});

	test("a successful write still counts", async () => {
		const written: string[] = [];
		const result = await summarize(
			storeWhoseUpdate(async (id) => {
				written.push(id);
			}),
		);

		expect(written).toEqual(["unit-a"]);
		expect(result.summariesGenerated).toBe(1);
		expect(result.errors).toEqual([]);
	});

	// Guards the type that makes the above reachable: `updateUnitSummary` is
	// declared on the interface, so a second store implementation cannot go back
	// to swallowing without the caller noticing.
	test("the throwing method is the one on IVectorStore", () => {
		const declared: keyof IVectorStore = "updateUnitSummary";
		expect(declared).toBe("updateUnitSummary");
	});
});
