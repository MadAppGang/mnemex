/**
 * The caching PROXY over `IEmbeddingsClient` (Phase 2 — pure addition, NO WIRING).
 *
 * `references/patterns/proxy.md`: a Proxy "decides whether and when the operation
 * runs at all" and "may NOT delegate". That is exactly this class — on a full
 * cache hit the wrapped client is never called. It is deliberately NOT called a
 * Decorator: a Decorator's inner call always happens, so a Decorator's progress
 * callbacks always fire, and naming this one would predict the wrong failure mode
 * and hide THE hazard this file is written around.
 *
 * This is a REAL OBJECT WRAPPER. It never mutates or monkey-patches `inner`
 * (contrast `withLatencyTracking`, `embeddings.ts:1287`, which patches
 * `client.embed` in place and returns the same object). `getModel`,
 * `getProvider` and `isLocal` delegate verbatim, so an indexer that records the
 * model and provider from the seam records the true ones.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HAZARD — two staleness rules, not one.
 *
 * `isLockStale()` (`lock.ts:157-187`) reclaims a held index lock when EITHER:
 *
 *   PRIMARY   now - (lastProgressAt ?? heartbeat) > DEFAULT_PROGRESS_TIMEOUT  (300 000 ms)
 *   SECONDARY now -  heartbeat                    > DEFAULT_STALE_TIMEOUT     ( 10 000 ms)
 *
 * `recordProgress()` writes `lastProgressAt` ONLY (CLAUDE.md #20). `heartbeat`
 * is written ONLY by `startHeartbeat()`'s 1 s `setInterval` (`lock.ts:51-52`
 * says so). So this file owes TWO different things, and neither implies the
 * other:
 *
 *   1. EVERY ITEM MUST ADVANCE PROGRESS, HIT OR MISS. On a hit the inner client
 *      is never called, so the callback that stamps `lastProgressAt` never fires
 *      by itself. `ProgressTicker` is what fires it. A warm all-hits run makes
 *      ZERO network calls, which is the feature working — and, without the
 *      ticker, zero stamps.
 *   2. NO SYNCHRONOUS REGION MAY STARVE THE 1 s HEARTBEAT TIMER. Every SQLite
 *      call behind `sqlite.ts` is synchronous and blocks the event loop. The
 *      lookup loop therefore yields at `LOOKUP_CHUNK` boundaries and
 *      `flushWrites` yields after every `WRITE_CHUNK`/`EVICT_CHUNK` slice, which
 *      is the same region discipline `embed-cache.ts` documents under
 *      "THE ARITHMETIC" (B_max = 500 ms; 1000 + 500 + 1 = 1501 < 10000).
 *
 * This is CLAUDE.md #27's mechanism with synchronous SQLite in place of
 * `Bun.spawnSync`, and this repository has already paid for it once.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IMPORT ALLOWLIST — `../types.js` (types only), `./embed-cache.js`,
 * `./embeddings-errors.js`, and node builtins. NOT `./indexer.js`, NOT
 * `./embeddings.js`, NOT `../config.js`. Enforced by
 * `test/unit/core/embed-cache-imports.test.ts`. The reason `embeddings.ts` is
 * forbidden is `TotalEmbeddingFailureError`: catching it by identity needs the
 * constructor at runtime, so it lives in a no-import leaf that both sides may
 * see (`embeddings-errors.ts`).
 *
 * Gotchas this file is written against:
 *   #15 a zero-length vector is a corrupt-index generator. Never stored, never
 *       served, compared against `0` explicitly — never `if (vec.length)`.
 *   #16 a model name does not identify its provider. Every key is computed from
 *       `inner.getModel()` and every row addressed with `inner.getProvider()`,
 *       never from a tracker string (§3.6's identity rule).
 *   #20 progress callbacks must stamp the lock. See `ProgressTicker`.
 *   #27 blocking is bounded per PROCESS by a pre-flight clamp, and every region
 *       ends in a yield.
 */

import type {
	EmbeddingProgressCallback,
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../types.js";
import type {
	EmbedCacheEntry,
	EmbedCacheLike,
	EmbedCacheMode,
	EmbedCacheStats,
	EmbedCacheTier,
	ModelDims,
	TouchKey,
	VetoedRow,
} from "./embed-cache.js";
import {
	EVICT_CHUNK,
	embedCacheKey,
	LOOKUP_CHUNK,
	resolveEmbedCacheMode,
	WRITE_CHUNK,
	yieldToEventLoop,
} from "./embed-cache.js";
import { TotalEmbeddingFailureError } from "./embeddings-errors.js";

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/**
 * Items between coalesced progress emits. Equal to `LOOKUP_CHUNK` on purpose:
 * one bounded region is one stamp, which is guarantee 2 of §6.1.
 *
 * Per-item CALLBACK INVOCATION is deliberately not attempted. `recordProgress()`
 * is a synchronous read+write of the lock file, times two locks, and its own
 * docstring says "never on a timer or in a tight loop". 100 000 all-hit items
 * would be 400 000 synchronous file operations; coalescing at 64 makes it ~6 000.
 */
export const PROGRESS_TICK_ITEMS = 64;

/**
 * Wall-clock ceiling between coalesced emits, for the case where the reported
 * number does not move (a cold scan resolves no items, and a Rule R restart
 * re-walks ground it has already reported). `PROGRESS_TICK_MS` must stay
 * `<= DEFAULT_PROGRESS_TIMEOUT / 100`; pinned by §6.3 Test C.
 */
export const PROGRESS_TICK_MS = 250;

/** L0 in-process memo budget, in bytes of vector payload. */
export const DEFAULT_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * `keys` and `cacheHits` now live on `EmbedResult` itself (Phase 3+4), so this
 * is a plain alias.
 *
 * Phase 2 declared them locally, as `CachedEmbedResult extends EmbedResult`,
 * because `src/types.ts` belongs to Phase 3+4 and that phase cannot be split
 * from the store column and the index-version bump: a 23rd field on
 * `StoredChunk` without the version bump lets a v3 batch reach a live v2 table.
 * Phase 3+4 moved the two fields onto the shared type and aliased the local name
 * away, which is why every call site below still reads `CachedEmbedResult` and
 * none of them changed.
 *
 * Kept as an alias rather than deleted so the seam's return type still SAYS at
 * each signature that the two extra fields are the point of the call.
 */
export type CachedEmbedResult = EmbedResult;

/**
 * `EmbeddingProgressCallback` now carries the 4th `cachedHits` parameter itself
 * (Phase 3+4), so this too is a plain alias. Same reason as
 * `CachedEmbedResult`; every existing 3-parameter callback stays assignable.
 */
export type CacheAwareProgressCallback = EmbeddingProgressCallback;

export interface CachingEmbeddingsClientOptions {
	inner: IEmbeddingsClient;
	/** `null` ⇒ the L0 tier only (or nothing at all, when `mode` is "off"). */
	cache: EmbedCacheLike | null;
	mode: EmbedCacheMode;
	/**
	 * Everything the inner client does to the text before sending it that
	 * (model, dimension) does not already capture — `""` when it does nothing.
	 * Computed by the indexer via `embeddingTextFingerprint()` and INJECTED,
	 * because this module may not import `embeddings.ts`.
	 */
	clientFingerprint: string;
	/** L0 byte budget. `0` disables L0 entirely. */
	memoryBudgetBytes?: number;
	progressTickItems?: number;
	progressTickMs?: number;
}

export interface CachingEmbeddingsStats {
	mode: EmbedCacheMode;
	/** `"sqlite"` only when a persistent cache is open AND healthy. */
	tier: EmbedCacheTier;
	hits: number;
	l0Hits: number;
	misses: number;
	/** Entries handed to `putMany`. Not the same as rows written — see the cache. */
	writes: number;
	/** Rule R firings. */
	dimensionCorrections: number;
	/** Rule R restarts (at most one per public call). */
	restarts: number;
	/** Total-failure batches served from cache instead of thrown. */
	downgrades: number;
	cache: EmbedCacheStats | null;
}

/**
 * NFR-2. The cache key is sound only while the embedded text IS the chunk's own
 * content. Research F6: Anthropic's Contextual Retrieval prepends 50-100 tokens
 * generated against the WHOLE DOCUMENT, which falsifies chunk-body-hash
 * addressing outright. If that ever lands here, this throws instead of silently
 * serving vectors for text that was never embedded.
 */
export class EmbedCacheSoundnessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmbedCacheSoundnessError";
	}
}

/**
 * Assert that what is about to be sent is byte-identical to the items' own
 * content.
 *
 * Called by `embedContentOf` on the array it is about to dispatch, with the
 * contents read AGAIN from the items — so it catches a transform inserted
 * between derivation and dispatch, which is the only way the two can diverge
 * inside one function.
 */
export function assertEmbeddedTextIsChunkContent(
	texts: readonly string[],
	contents: readonly string[],
	site: "chunks" | "code-units" | "docs",
): void {
	if (texts.length !== contents.length) {
		throw new EmbedCacheSoundnessError(
			`embed cache soundness (${site}): about to embed ${texts.length} texts for ${contents.length} items. ` +
				"The cache key is over the item's own content; a different count means it is not.",
		);
	}
	for (let i = 0; i < texts.length; i++) {
		if (texts[i] !== contents[i]) {
			throw new EmbedCacheSoundnessError(
				`embed cache soundness (${site}): the text at slot ${i} is not the item's content. ` +
					"A transform below this line would make every cache key address a vector for text that was never embedded. " +
					`Sent ${describe(texts[i])}, item holds ${describe(contents[i])}.`,
			);
		}
	}
}

function describe(text: string | undefined): string {
	if (text === undefined) return "<missing>";
	const head = text.length > 60 ? `${text.slice(0, 60)}…` : text;
	return `${text.length} chars ${JSON.stringify(head)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// ProgressTicker — mechanism 1, for the 300 s rule
// ════════════════════════════════════════════════════════════════════════════

/**
 * Coalesced progress accounting that fires whether or not the inner client is
 * called.
 *
 * Guarantees, each pinned by a test:
 *
 *  1. Every item is ACCOUNTED. `completed` reaches `total` on a pass that
 *     completes, and never exceeds it. `final()` is idempotent, and it does not
 *     re-emit a value that was just emitted — so the inner client's own terminal
 *     `onProgress(n, n, 0)` followed by `final()` emits at `n` ONCE, not twice.
 *  2. A stamp happens at least once per bounded region: `advance()` is called
 *     per item and emits every `everyItems` CALLS, independently of whether the
 *     reported number moved.
 *  3. The miss path's stamping frequency is UNCHANGED: `forward()` emits
 *     one-for-one, never coalesced, so today's per-item network behaviour is
 *     preserved exactly.
 *  4. A terminal stamp always fires — including on `embed([])`, on an all-hits
 *     batch where the inner client is never touched, and ON A THROW, because
 *     `final()` is called from a `finally`.
 *  5. `completed` is MONOTONIC NON-DECREASING and `total` is the caller's full
 *     `texts.length`, so a renderer sees one continuous 0→N progression.
 *
 *     ME-3, resolved rather than waived: Rule R restarts the batch, and a naive
 *     ticker would rewind. `raise()` clamps to the high-water mark, so the
 *     REPORTED number plateaus across a restart instead of going backwards —
 *     while the EMIT still happens every `everyItems` calls, because guarantee 2
 *     counts calls, not deltas. Monotonicity and stamping are therefore
 *     independent, which is what makes both hold at once.
 *  6. The live hit count travels with the progress, as the optional 4th
 *     parameter.
 */
export class ProgressTicker {
	private completed = 0;
	private hits = 0;
	private itemsSinceEmit = 0;
	private lastEmitAt: number;
	private lastEmittedCompleted: number | null = null;
	private emits = 0;
	private finished = false;

	constructor(
		private readonly cb: CacheAwareProgressCallback | undefined,
		private readonly total: number,
		private readonly everyItems: number = PROGRESS_TICK_ITEMS,
		private readonly everyMs: number = PROGRESS_TICK_MS,
	) {
		// Seeded to construction time, not 0: the elapsed-time rule measures the
		// gap since the LAST STAMP, and the batch's own start is one. Leaving it at
		// 0 would make the very first item emit unconditionally, which is harmless
		// but makes the coalescing schedule depend on the epoch.
		this.lastEmitAt = Date.now();
	}

	/**
	 * One item resolved from the cache scan — HIT OR MISS. The SQLite work is
	 * real work regardless of the outcome, so a miss advances the ticker too.
	 *
	 * `completed` is the number of items actually RESOLVED so far (i.e. the hit
	 * count), not the scan index: a miss is not done until phase 2 embeds it, and
	 * reporting the scan index would drive the bar to 100 % before a single
	 * network call had been made, then plateau through the whole of phase 2.
	 */
	advance(completed: number, hits: number): void {
		this.hits = hits;
		this.raise(completed);
		this.itemsSinceEmit++;
		if (this.itemsSinceEmit >= this.everyItems) {
			this.emit(undefined);
			return;
		}
		if (Date.now() - this.lastEmitAt >= this.everyMs) this.emit(undefined);
	}

	/** An inner-client callback, re-based into the full index space. Never coalesced. */
	forward(
		completed: number,
		inProgress: number | undefined,
		hits: number,
	): void {
		this.hits = hits;
		this.raise(completed);
		this.emit(inProgress);
	}

	/** Unconditional emit. Called immediately BEFORE and AFTER every transaction. */
	flush(): void {
		this.emit(undefined);
	}

	/**
	 * Terminal accounting for a pass that COMPLETED: `completed` reaches `total`.
	 * Emits only if that moved the number, so guarantee 1 is not violated by a
	 * batch whose last flush already reported `total`.
	 */
	settle(): void {
		this.raise(this.total);
		if (this.lastEmittedCompleted !== this.completed) this.emit(undefined);
	}

	/**
	 * Terminal emit, idempotent, ALWAYS reached — it is called from a `finally`.
	 * Emits at the count actually reached, never at `total`: a batch that threw
	 * half-way did not complete, and saying it did would be a lie told to the
	 * one mechanism that decides whether this process still holds its lock.
	 */
	final(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.lastEmittedCompleted === this.completed) return;
		this.emit(undefined);
	}

	/** Test seam: how many times the callback was invoked. */
	get emitCount(): number {
		return this.emits;
	}

	/** Test seam. */
	get completedCount(): number {
		return this.completed;
	}

	/** Test seam. */
	get isFinished(): boolean {
		return this.finished;
	}

	private raise(completed: number): void {
		const clamped =
			completed < 0 ? 0 : completed > this.total ? this.total : completed;
		if (clamped > this.completed) this.completed = clamped;
	}

	private emit(inProgress: number | undefined): void {
		this.itemsSinceEmit = 0;
		this.lastEmitAt = Date.now();
		this.lastEmittedCompleted = this.completed;
		this.emits++;
		this.cb?.(this.completed, this.total, inProgress, this.hits);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// L0 — the in-process memo
// ════════════════════════════════════════════════════════════════════════════

/**
 * A byte-budgeted insertion-ordered memo. It exists so that a run whose
 * persistent tier is unavailable still reuses within itself, and so that a hit
 * on a repeated text costs no SQLite region at all.
 *
 * It stores the SAME array instance it hands back. Callers must not mutate a
 * returned vector — the indexer does not, and copying every vector would double
 * the cost of the thing this memo exists to make cheap.
 */
class MemoL0 {
	private readonly map = new Map<string, number[]>();
	private bytes = 0;

	constructor(private readonly budgetBytes: number) {}

	get(key: string): number[] | undefined {
		return this.map.get(key);
	}

	set(key: string, vector: number[]): void {
		if (this.budgetBytes === 0) return;
		// CLAUDE.md #15: `=== 0`, never truthiness. A zero-length vector is never
		// memoised, because it would then be SERVED.
		if (vector.length === 0) return;
		if (this.map.has(key)) return;
		this.map.set(key, vector);
		this.bytes += vector.length * 8;
		while (this.bytes > this.budgetBytes) {
			const oldest = this.map.keys().next();
			if (oldest.done === true) break;
			const evicted = this.map.get(oldest.value);
			this.map.delete(oldest.value);
			this.bytes -= (evicted?.length ?? 0) * 8;
		}
	}

	clear(): void {
		this.map.clear();
		this.bytes = 0;
	}

	get size(): number {
		return this.map.size;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// The proxy
// ════════════════════════════════════════════════════════════════════════════

export class CachingEmbeddingsClient implements IEmbeddingsClient {
	private readonly inner: IEmbeddingsClient;
	private readonly cache: EmbedCacheLike | null;
	private readonly mode: EmbedCacheMode;
	private readonly fingerprint: string;
	private readonly l0: MemoL0;
	private readonly tickItems: number;
	private readonly tickMs: number;

	private hits = 0;
	private l0Hits = 0;
	private misses = 0;
	private writes = 0;
	private dimensionCorrections = 0;
	private restarts = 0;
	private downgrades = 0;

	constructor(opts: CachingEmbeddingsClientOptions) {
		this.inner = opts.inner;
		this.mode = opts.mode;
		// The user's opt-out switches off EVERY tier, including L0. Degradation
		// moves the tier and never the mode, so a disk failure can never reach
		// here and be mistaken for the opt-out.
		this.cache = opts.mode === "off" ? null : opts.cache;
		this.fingerprint = opts.clientFingerprint;
		this.l0 = new MemoL0(
			opts.mode === "off"
				? 0
				: (opts.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES),
		);
		this.tickItems = opts.progressTickItems ?? PROGRESS_TICK_ITEMS;
		this.tickMs = opts.progressTickMs ?? PROGRESS_TICK_MS;
	}

	// ── IEmbeddingsClient — all six members ──────────────────────────────────

	async embed(
		texts: string[],
		onProgress?: CacheAwareProgressCallback,
	): Promise<CachedEmbedResult> {
		return this.run(texts, onProgress);
	}

	/**
	 * The second embedding entry point, and the one that is easy to forget.
	 * It goes through the same seam, so a single text is cached like any other,
	 * and it keeps the concrete clients' refusal to return an empty vector
	 * (CLAUDE.md #15: "`embedOne` refuses a zero-length vector").
	 */
	async embedOne(text: string): Promise<number[]> {
		const result = await this.run([text], undefined);
		const vector = result.embeddings[0];
		// `=== 0`, never truthiness.
		if (vector === undefined || vector.length === 0) {
			throw new Error(
				`${this.inner.getProvider()} returned an empty embedding for a single text (model ${this.inner.getModel()})`,
			);
		}
		return vector;
	}

	getModel(): string {
		return this.inner.getModel();
	}

	/**
	 * The inner client's dimension, or — when it has not made a call yet in this
	 * process — the one this model produced last time, read from the cache
	 * WITHOUT a network call. That second source is what makes a warm run cost
	 * zero embedding calls.
	 */
	getDimension(): number | undefined {
		return this.resolveDimension();
	}

	getProvider(): EmbeddingProvider {
		return this.inner.getProvider();
	}

	isLocal(): boolean {
		return this.inner.isLocal();
	}

	// ── The NFR-2 pin, made structural ───────────────────────────────────────

	/**
	 * Embed the items' own content, deriving the texts HERE.
	 *
	 * The point is structural rather than asserted: because the texts are derived
	 * inside this module, `texts[i] === items[i].content` is a property of the
	 * code rather than of a comparison between two arrays that a local edit can
	 * change together. The assertion below is the second half — it re-reads the
	 * items at DISPATCH time, so a transform inserted between derivation and
	 * dispatch is caught rather than silently poisoning every key.
	 */
	async embedContentOf<T extends { content: string }>(
		items: readonly T[],
		site: "chunks" | "code-units" | "docs",
		onProgress?: CacheAwareProgressCallback,
	): Promise<CachedEmbedResult> {
		const texts = items.map((item) => item.content);
		// Any future transform of `texts` would go here — which is exactly why the
		// assertion is BELOW it and reads `item.content` again.
		assertEmbeddedTextIsChunkContent(
			texts,
			items.map((item) => item.content),
			site,
		);
		return this.run(texts, onProgress);
	}

	/**
	 * The key this proxy WOULD compute for `text`. `""` when no dimension is
	 * known, because a key without a dimension addresses nothing.
	 *
	 * Exists so the retained L1 (`oldChunksCache`) path can carry FR-2's
	 * `embedKey` for a vector it reused from LanceDB, WITHOUT duplicating the key
	 * formula — the formula still lives in exactly one file.
	 */
	keyFor(text: string, dimension?: number): string {
		const dim = dimension ?? this.resolveDimension();
		// `=== 0`, never truthiness: 0 is not a dimension (CLAUDE.md #15).
		if (dim === undefined || dim === 0) return "";
		return embedCacheKey(this.inner.getModel(), dim, text);
	}

	stats(): CachingEmbeddingsStats {
		const cacheStats = this.cache?.stats() ?? null;
		return {
			mode: this.mode,
			tier:
				this.mode === "off"
					? "none"
					: cacheStats === null
						? "l0"
						: cacheStats.tier,
			hits: this.hits,
			l0Hits: this.l0Hits,
			misses: this.misses,
			writes: this.writes,
			dimensionCorrections: this.dimensionCorrections,
			restarts: this.restarts,
			downgrades: this.downgrades,
			cache: cacheStats,
		};
	}

	/** Test seam: how many vectors the in-process memo is holding. */
	memoSizeForTests(): number {
		return this.l0.size;
	}

	// ── The run ──────────────────────────────────────────────────────────────

	private async run(
		texts: readonly string[],
		onProgress: CacheAwareProgressCallback | undefined,
	): Promise<CachedEmbedResult> {
		if (this.mode === "off") {
			// The opt-out is a pass-through, not a degraded cache: no ticker, no
			// keys, no lookups, the caller's callback forwarded verbatim. Today's
			// behaviour, byte for byte.
			return this.inner.embed([...texts], onProgress);
		}

		const ticker = new ProgressTicker(
			onProgress,
			texts.length,
			this.tickItems,
			this.tickMs,
		);
		try {
			const result = await this.pass(texts, ticker, undefined, false);
			ticker.settle();
			return result;
		} finally {
			// Guarantee 4. Reached on every path, including a throw and `embed([])`.
			ticker.final();
		}
	}

	/**
	 * One two-phase pass over the batch. Called a second time — at most once —
	 * when Rule R fires.
	 *
	 * PHASE 1 is a cache scan with NO network at all, region R1, yielding every
	 * `LOOKUP_CHUNK`. PHASE 2 is ONE network call for the WHOLE miss set, so a
	 * miss at slot 0 can never cause N single-item API calls.
	 */
	private async pass(
		texts: readonly string[],
		ticker: ProgressTicker,
		forcedDim: number | undefined,
		restarted: boolean,
	): Promise<CachedEmbedResult> {
		const total = texts.length;
		// §3.6's identity rule: the model and provider always come from the client
		// that will actually perform the embedding — never from a tracker string,
		// never from config, never from `this.model`.
		const model = this.inner.getModel();
		const provider = this.inner.getProvider();

		let dim = forcedDim ?? this.resolveDimension();
		// `=== 0`, never truthiness.
		if (dim === 0) dim = undefined;

		const out: number[][] = new Array(total);
		const keys: string[] = new Array(total).fill("");
		const touched: TouchKey[] = [];
		const missIdx: number[] = [];
		const missTexts: string[] = [];
		let hitCount = 0;

		// ── PHASE 1 — cache scan, region R1 ──────────────────────────────────
		if (dim !== undefined) {
			for (let i = 0; i < total; i++) {
				const text = texts[i] as string;
				const key = embedCacheKey(model, dim, text);
				keys[i] = key;
				const vector = this.lookup(key, provider, dim);
				if (vector === undefined) {
					missIdx.push(i);
					missTexts.push(text);
				} else {
					out[i] = vector;
					hitCount++;
					// `touched` is collected on EVERY path, not only the all-hits one.
					// Without this, incremental indexing — the most common production
					// shape — never refreshes `last_used_at` and the LRU evicts the
					// most-reused rows first.
					touched.push({ key, provider });
				}
				ticker.advance(hitCount, hitCount);
				if ((i + 1) % LOOKUP_CHUNK === 0) await yieldToEventLoop();
			}
		} else {
			// An unknown dimension means no entry can be addressed for this model,
			// so the scan is skipped ENTIRELY rather than performed against a
			// guessed width. The dimension is then learned from the response below
			// and the keys are computed after it, so `keys` is complete even on the
			// very first run against a fresh cache.
			for (let i = 0; i < total; i++) {
				missIdx.push(i);
				missTexts.push(texts[i] as string);
			}
		}

		// Drained AFTER the scan: a vetoed row is a miss, and deleting it inside
		// the loop would interleave a write transaction into region R1.
		const evicted: VetoedRow[] = this.cache?.pendingEvictions() ?? [];

		// ── PHASE 2 — one network call for the whole miss set ────────────────
		let cost: number | undefined;
		let totalTokens: number | undefined;
		let warnings: string[] | undefined;
		let learnedDim: number | undefined;

		if (missTexts.length > 0) {
			ticker.flush();
			let inner: EmbedResult;
			try {
				inner = await this.inner.embed(missTexts, (c, _t, ip) => {
					// Re-based into the full index space, one-for-one (guarantee 3).
					ticker.forward(hitCount + c, ip, hitCount);
				});
			} catch (err) {
				return await this.onInnerFailure(
					err,
					ticker,
					out,
					keys,
					missIdx,
					touched,
					evicted,
					hitCount,
					dim,
				);
			}

			cost = inner.cost;
			totalTokens = inner.totalTokens;
			warnings = inner.warnings;
			for (let j = 0; j < missIdx.length; j++) {
				const vector = inner.embeddings[j];
				out[missIdx[j] as number] = vector === undefined ? [] : vector;
			}

			// §4.2's WRITER RULE. `model_dims` only ever receives a length taken
			// from a response vector this process actually received. There is no
			// other source anywhere in this feature — which is why a client that
			// returns nothing but `[]` leaves `knownDimension()` undefined forever
			// rather than poisoning a machine-global row that is never invalidated.
			const firstReal = inner.embeddings.find(
				(v) => v !== undefined && v.length !== 0,
			);
			const trueDim = firstReal === undefined ? undefined : firstReal.length;

			if (trueDim !== undefined && dim === undefined) {
				dim = trueDim;
				learnedDim = trueDim;
				for (let i = 0; i < total; i++) {
					keys[i] = embedCacheKey(model, trueDim, texts[i] as string);
				}
			} else if (trueDim !== undefined && trueDim !== dim) {
				return await this.correctDimension(
					texts,
					ticker,
					out,
					missIdx,
					touched,
					evicted,
					model,
					provider,
					dim as number,
					trueDim,
					restarted,
				);
			}
		}

		// ── Writes — one writer, chunked, stamping and yielding around each ──
		const entries: EmbedCacheEntry[] = [];
		if (dim !== undefined) {
			for (const i of missIdx) {
				const vector = out[i] as number[];
				// CLAUDE.md #15, write side. `=== 0`, never truthiness: a zero-length
				// vector is a corrupt-index generator and is never stored.
				if (vector.length === 0) continue;
				// Width homogeneity is a property of what this returns, so a vector
				// that disagrees with the resolved dimension is never written under a
				// key that encodes a different one. Unreachable after Rule R; kept
				// because "unreachable" is a claim about today's callers.
				if (vector.length !== dim) continue;
				const key = keys[i] as string;
				if (key.length === 0) continue;
				this.l0.set(key, vector);
				entries.push({
					key,
					model,
					provider,
					dimension: dim,
					fingerprint: this.fingerprint,
					vector,
				});
			}
		}

		await this.flushWrites(
			ticker,
			entries,
			touched,
			evicted,
			learnedDim === undefined
				? undefined
				: { model, provider, dimension: learnedDim },
		);

		this.hits += hitCount;
		this.misses += missIdx.length;
		this.writes += entries.length;

		return this.result(out, keys, dim, hitCount, cost, totalTokens, warnings);
	}

	/**
	 * The total-failure downgrade (H3), and the one case where it must NOT apply.
	 *
	 * `assertNotTotalFailure`'s own docstring says a 100 % failure rate "is not
	 * that case — nothing about it is per-chunk", and CLAUDE.md #15 says the same.
	 * Both are statements about a LARGE SAMPLE. Once the cache works, the miss set
	 * shrinks, so the probability of the whole miss set failing rises MONOTONICALLY
	 * WITH THE HIT RATE: the feature would make its own fatal error more likely the
	 * better it worked. So the predicate is re-evaluated over the WHOLE BATCH:
	 *
	 *   hitCount > 0  ⇒ fill the miss slots with `[]`, record the warning, return.
	 *   hitCount === 0 ⇒ RETHROW. A cold batch that failed entirely is a genuine
	 *                    100 % failure and must stay fatal.
	 *
	 * `isFatalEmbeddingFailure`'s rethrows (401 / 403 / model-unavailable) are a
	 * DIFFERENT error and are never downgraded — they are not
	 * `TotalEmbeddingFailureError`, so they fall through to the rethrow.
	 */
	private async onInnerFailure(
		err: unknown,
		ticker: ProgressTicker,
		out: number[][],
		keys: string[],
		missIdx: readonly number[],
		touched: readonly TouchKey[],
		evicted: readonly VetoedRow[],
		hitCount: number,
		dim: number | undefined,
	): Promise<CachedEmbedResult> {
		if (!(err instanceof TotalEmbeddingFailureError) || hitCount === 0)
			throw err;

		this.downgrades++;
		for (const i of missIdx) out[i] = [];
		// The hits are real and their rows deserve their LRU refresh; no entries
		// exist to write, because nothing was embedded.
		await this.flushWrites(ticker, [], touched, evicted, undefined);
		this.hits += hitCount;
		this.misses += missIdx.length;
		return this.result(out, keys, dim, hitCount, undefined, undefined, [
			err.message,
		]);
	}

	/**
	 * RULE R — a dimension correction restarts the batch, at most once.
	 *
	 * Reachable without any migration: an Ollama model re-pulled under the same
	 * name, an OpenRouter model updated, a Matryoshka setting changed. The naive
	 * handling returns hit vectors of the STALE width interleaved with miss
	 * vectors of the TRUE width, and nothing downstream requires homogeneity —
	 * `addChunks` inspects `data[0]` only, so whichever width is first defines the
	 * Arrow column and every row of the other width is handed to `table.add`.
	 * That is the CLAUDE.md #15 family of defect reached through the one array
	 * the contract treated as type-uniform.
	 *
	 * Nothing is thrown away: the vectors just embedded are CORRECT, so they are
	 * written under `trueDim` keys first. The restart therefore finds them as
	 * hits, and only the former stale-dimension hits reach the network on pass 2.
	 * Homogeneity then holds BY CONSTRUCTION rather than by inspection.
	 */
	private async correctDimension(
		texts: readonly string[],
		ticker: ProgressTicker,
		out: number[][],
		missIdx: readonly number[],
		touched: readonly TouchKey[],
		evicted: readonly VetoedRow[],
		model: string,
		provider: EmbeddingProvider,
		staleDim: number,
		trueDim: number,
		restarted: boolean,
	): Promise<CachedEmbedResult> {
		this.dimensionCorrections++;
		this.cache?.noteDimensionCorrection?.();

		// Step 1+2 — record the true width and keep the vectors, keyed under it.
		// The dimension travels in the SAME transaction as the entries, so
		// `model_dims` and the rows it makes addressable cannot disagree.
		this.l0.clear();
		const entries: EmbedCacheEntry[] = [];
		for (const i of missIdx) {
			const vector = out[i] as number[];
			if (vector.length === 0 || vector.length !== trueDim) continue;
			const key = embedCacheKey(model, trueDim, texts[i] as string);
			this.l0.set(key, vector);
			entries.push({
				key,
				model,
				provider,
				dimension: trueDim,
				fingerprint: this.fingerprint,
				vector,
			});
		}
		await this.flushWrites(ticker, entries, [], evicted, {
			model,
			provider,
			dimension: trueDim,
		});
		this.writes += entries.length;

		// Step 3 — every phase-1 hit was served under the stale width. Delete on
		// the FULL identity the row had, never on the primary key: the same
		// (key, provider) may have just been rewritten, and a delete by key would
		// remove the row that was written a moment ago.
		const stale: VetoedRow[] = touched.map((t) => ({
			key: t.key,
			provider: t.provider,
			dim: staleDim,
			fingerprint: this.fingerprint,
			bytes: staleDim * 4,
		}));
		await this.flushWrites(ticker, [], [], stale, undefined);

		// Step 5 — bounded. A second correction inside one call is not a stale
		// row, it is a client changing its output width mid-batch, and there is no
		// width this call could honestly return.
		if (restarted) {
			throw new Error(
				`embedding dimension changed twice in one batch (${staleDim} then ${trueDim}, model ${model}, provider ${provider})`,
			);
		}
		this.restarts++;
		return this.pass(texts, ticker, trueDim, true);
	}

	/**
	 * THE ONLY caller of `putMany` and `evictKeys` in this module.
	 *
	 * Every path — hit, miss, mixed, veto, Rule R, downgrade — goes through it,
	 * so the chunk bound and the stamp/yield discipline are written ONCE instead
	 * of once per path. Spelling the write out per path is how the all-hits
	 * spelling came to omit the chunking and the mixed spelling came to omit
	 * `touched` altogether; one writer removes both classes of omission by
	 * construction.
	 *
	 * Each slice is one bounded synchronous region (R2 for a write, R3 for an
	 * evict), stamped on both sides and followed by a yield so a due heartbeat
	 * interval can run before the next region starts.
	 */
	private async flushWrites(
		ticker: ProgressTicker,
		entries: readonly EmbedCacheEntry[],
		touched: readonly TouchKey[],
		evicted: readonly VetoedRow[],
		dims: ModelDims | undefined,
	): Promise<void> {
		const cache = this.cache;
		if (cache === null) return;

		// The dimension rides along with the FIRST write of the batch so it lands
		// in the same transaction as the rows it makes addressable.
		let pendingDims = dims;

		for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
			const slice = entries.slice(i, i + WRITE_CHUNK);
			ticker.flush();
			cache.putMany(slice, [], pendingDims);
			pendingDims = undefined;
			ticker.flush();
			await yieldToEventLoop();
		}
		if (pendingDims !== undefined) {
			ticker.flush();
			cache.putMany([], [], pendingDims);
			ticker.flush();
			await yieldToEventLoop();
		}
		for (let i = 0; i < touched.length; i += WRITE_CHUNK) {
			const slice = touched.slice(i, i + WRITE_CHUNK);
			ticker.flush();
			cache.putMany([], slice);
			ticker.flush();
			await yieldToEventLoop();
		}
		for (let i = 0; i < evicted.length; i += EVICT_CHUNK) {
			const slice = evicted.slice(i, i + EVICT_CHUNK);
			ticker.flush();
			cache.evictKeys(slice);
			ticker.flush();
			await yieldToEventLoop();
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	/**
	 * §4.2's resolution order: the live client first, then what this model
	 * produced last time. A `0` from either source is not a dimension.
	 */
	private resolveDimension(): number | undefined {
		const live = this.inner.getDimension();
		if (live !== undefined && live !== 0) return live;
		const known = this.cache?.knownDimension(
			this.inner.getModel(),
			this.inner.getProvider(),
		);
		if (known !== undefined && known !== 0) return known;
		return undefined;
	}

	private lookup(
		key: string,
		provider: EmbeddingProvider,
		dim: number,
	): number[] | undefined {
		const memo = this.l0.get(key);
		if (memo !== undefined) {
			this.l0Hits++;
			return memo;
		}
		const vector = this.cache?.get(key, provider, dim, this.fingerprint);
		if (vector === undefined) return undefined;
		// CLAUDE.md #15, read side. The cache refuses these too; this is the second
		// of the two boundaries, because a vector that reaches `addChunks` with the
		// wrong length is not recoverable.
		if (vector.length === 0) return undefined;
		if (vector.length !== dim) return undefined;
		this.l0.set(key, vector);
		return vector;
	}

	private result(
		embeddings: number[][],
		keys: string[],
		dim: number | undefined,
		cacheHits: number,
		cost: number | undefined,
		totalTokens: number | undefined,
		warnings: string[] | undefined,
	): CachedEmbedResult {
		const result: CachedEmbedResult = { embeddings, cacheHits };
		// A key without a dimension addresses nothing, so it is not reported.
		if (dim !== undefined) result.keys = keys;
		if (cost !== undefined) result.cost = cost;
		if (totalTokens !== undefined) result.totalTokens = totalTokens;
		if (warnings !== undefined) result.warnings = warnings;
		return result;
	}
}

/**
 * The factory the indexer uses. NEVER THROWS: the cache is an optimisation, and
 * the only thing a failure of it may ever cost is a recompute.
 *
 * It TAKES the cache handle rather than opening one. The handle's lifecycle
 * belongs to `Indexer.index()`, which opens it before both locks — which is also
 * what stops `Indexer.clear()`, which initialises a client and never embeds,
 * from creating and DDL-ing a SQLite file it will not use.
 *
 * Deliberately NOT placed behind `createEmbeddingsClient()`: `embeddings.ts`
 * already imports `config.ts`, and moving the factory there would pull the cache
 * into that graph and make the import allowlist unenforceable.
 */
export function createCachingEmbeddingsClient(
	inner: IEmbeddingsClient,
	opts: {
		cache: EmbedCacheLike | null;
		configEnabled?: boolean;
		clientFingerprint: string;
		memoryBudgetBytes?: number;
	},
): CachingEmbeddingsClient {
	const mode = resolveEmbedCacheMode(opts.configEnabled);
	return new CachingEmbeddingsClient({
		inner,
		cache: mode === "off" ? null : opts.cache,
		mode,
		clientFingerprint: opts.clientFingerprint,
		memoryBudgetBytes: opts.memoryBudgetBytes,
	});
}
