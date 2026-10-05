/**
 * R2.2 / R2.3 — `code_unit` is a real `DocumentType`, with a CHOSEN weight.
 *
 * Before: `storedRowsForUnits` wrote `documentType: "code_unit"` (26.5 % of
 * measured result rows), the union did not contain it, and every weight lookup
 * for it took `typeAwareRRFFusion`'s `?? 0.1` — a value nobody chose, which
 * decides which twin survives the R2 collapse.
 *
 *   T-3  every use-case table AND the default table carry an explicit
 *        `code_unit` entry, in `store.ts` and in `retrieval/retriever.ts`.
 *        0.1 is today's effective value, so this is ranking-neutral
 *        (orchestrator ruling 3); "equal to `code_chunk`" is an eval, not this.
 *   T-5  the type admits it, and every total `Record<DocumentType, …>` the
 *        compiler surfaced has a deliberate entry for it.
 */

import { describe, expect, test } from "bun:test";
import { createDependencyGraph } from "../../../src/core/enrichment/dependency-graph.js";
import {
	classifyDocumentType,
	DERIVED_DOCUMENT_TYPES,
} from "../../../src/core/invalidation.js";
import { getUseCaseWeights } from "../../../src/core/store.js";
import { SYSTEM_PROMPTS } from "../../../src/llm/prompts/enrichment.js";
import { DEFAULT_TYPE_WEIGHTS } from "../../../src/retrieval/retriever.js";
import type { DocumentType, SearchUseCase } from "../../../src/types.js";

const USE_CASES: readonly SearchUseCase[] = ["fim", "search", "navigation"];

describe("T-3 — `code_unit` has an explicit weight in every table", () => {
	test("store.ts: fim, search, navigation and the default table (A)", () => {
		for (const useCase of [...USE_CASES, undefined]) {
			const table = getUseCaseWeights(useCase);
			expect(Object.hasOwn(table, "code_unit"), String(useCase)).toBe(true);
			expect(table.code_unit, String(useCase)).toBe(0.1);
		}
	});

	test("retrieval/retriever.ts: DEFAULT_TYPE_WEIGHTS, every use case (A)", () => {
		for (const useCase of USE_CASES) {
			const table = DEFAULT_TYPE_WEIGHTS[useCase];
			expect(Object.hasOwn(table, "code_unit"), useCase).toBe(true);
			expect(table.code_unit, useCase).toBe(0.1);
		}
	});

	test("the twin weight never EXCEEDS code_chunk's: the collapse keeps what it kept before", () => {
		for (const useCase of [...USE_CASES, undefined]) {
			const table = getUseCaseWeights(useCase);
			expect(table.code_unit ?? 0).toBeLessThanOrEqual(table.code_chunk ?? 0);
		}
	});
});

describe("T-5 — `code_unit` is a DocumentType", () => {
	test("the union admits it (compile-time; `bun run typecheck` is the gate)", () => {
		const t = "code_unit" satisfies DocumentType;
		expect(t).toBe("code_unit");
	});

	test("invalidation classifies it as DERIVED, not the unknown-type fallback", () => {
		// Re-derivable from source like `code_chunk`. Before, it fell to
		// `classifyDocumentType`'s "observed" fallback for unknown strings.
		expect(classifyDocumentType("code_unit")).toBe("derived");
		expect(DERIVED_DOCUMENT_TYPES).toContain("code_unit");
	});

	test("enrichment has no prompt for it and no dependencies", () => {
		// `""`, not `undefined`: the entry exists and says "not generated".
		expect(Object.hasOwn(SYSTEM_PROMPTS, "code_unit")).toBe(true);
		expect(SYSTEM_PROMPTS.code_unit).toBe("");
		// `DEFAULT_DEPENDENCIES` is a total Record, so its entry is pinned by
		// the compiler; at runtime it must not make code_unit a prerequisite
		// of, or dependent on, anything.
		const graph = createDependencyGraph();
		expect(graph.getDependencies("code_unit")).toEqual([]);
		expect(graph.getDependents("code_unit")).toEqual([]);
	});
});
