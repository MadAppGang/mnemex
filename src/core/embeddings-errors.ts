/**
 * Embedding errors that more than one module must recognise BY IDENTITY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE HAS NO IMPORTS, AND THAT IS ITS ENTIRE REASON TO EXIST.
 *
 * `src/core/caching-embeddings-client.ts` (Phase 2) has to catch the
 * total-failure error with `err instanceof TotalEmbeddingFailureError`, and
 * `instanceof` needs the constructor AT RUNTIME. If that class lived in
 * `embeddings.ts`, the caching proxy would have to import `embeddings.ts` —
 * which imports `config.ts`, which is one end of the import chain the baseline
 * test failure already runs through
 * (`config.ts:1665` → `mcp/tools/deps.ts:114` → `mcp/tools/search.ts:295`).
 * The architecture's import allowlist forbids it and a unit test enforces it
 * (`test/unit/core/embed-cache-imports.test.ts`).
 *
 * So the class lives in a leaf that imports nothing: `embeddings.ts` will import
 * it and throw it, the caching proxy imports it and catches it, and neither can
 * see the other.
 *
 * Precedent: `src/core/keychain.ts` owns `guardedProcessReason()` for exactly
 * this reason — it "has no imports, so no cycle" (CLAUDE.md #24).
 *
 * DO NOT ADD AN IMPORT TO THIS FILE. Not a type-only one either: a type-only
 * import is erased by the compiler but is still a line the allowlist test reads,
 * and the next edit that needs a value from the same module will quietly drop
 * the `type` keyword.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Every text in a batch failed to embed.
 *
 * CLAUDE.md #15: "a 100% failure rate is never a per-item condition, and an
 * embeddings client that can return `[]` is a corrupt-index generator." This is
 * the error `assertNotTotalFailure` in `embeddings.ts` throws at that point
 * (Phase 3 replaces its anonymous `throw new Error(...)` with this class; the
 * MESSAGE TEXT IS UNCHANGED, so nothing that matches on the string regresses).
 *
 * The caching proxy catches it to decide whether a batch can be DOWNGRADED —
 * served from cache with empty slots for the misses — or must propagate. That
 * decision needs the identity, not the message.
 */
export class TotalEmbeddingFailureError extends Error {
	constructor(
		readonly provider: string,
		readonly total: number,
		readonly firstCause: string,
	) {
		super(
			`${provider} embeddings failed for all ${total} texts, so this is not a per-text problem.\n` +
				`  First failure: ${firstCause}`,
		);
		this.name = "TotalEmbeddingFailureError";
	}
}
