/**
 * §6.3 TEST A — `lastProgressAt`, the 300 s rule.
 *
 * THE HAZARD. On a cache hit the wrapped client is never called, so the callback
 * that stamps the lock never fires by itself. `recordProgress()` advances
 * `lastProgressAt`, and `lastProgressAt` is the SOLE input to `isLockStale`'s
 * primary rule (CLAUDE.md #20, `lock.ts:157-187`). A warm run makes zero network
 * calls — which is the feature working — and, without the ticker, zero stamps.
 * A second indexer then reclaims a lock this process is still holding.
 *
 * HOW IT IS MEASURED. On the LOCK FILE, with a real `IndexLock`, sampled by an
 * independent timer — never on a callback counter. CLAUDE.md's doctrine is that
 * a report object cannot show what happened, and this repository has already
 * shipped a bug where a millisecond budget stood in for a spawn count. The
 * counting fake's `calls` is asserted too, because "the stamps came from the hit
 * path" is only meaningful if the miss path never ran.
 *
 * TWO BOUNDS, for the reason Phase 1's blocking test carries two probes:
 *
 *   - `DEFAULT_PROGRESS_TIMEOUT / 10` (30 000 ms) is the PRODUCTION property.
 *     It is also insensitive: a scan with the ticker removed entirely still
 *     comes nowhere near it at any size a unit test can afford, so a green run
 *     against it alone would prove nothing.
 *   - `B_max` (500 ms) is the design's own bound on ONE contiguous region
 *     (`embed-cache.ts`, "THE ARITHMETIC": 250 ms of clamped busy-wait plus
 *     250 ms of work). Guarantee 2 of §6.1 is "a stamp at least once per bounded
 *     region", so this is that guarantee stated as a number — and it is what
 *     makes the test falsifiable.
 *
 * FALSIFIED: re-run with `ticker.advance()`'s emit removed, the 500 ms assertion
 * goes red. The red output is pasted in the session implementation log.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import type { EmbedCache } from "../../../src/core/embed-cache.js";
import {
	embedCacheKey,
	openEmbedCache,
	resetEmbedCacheForTests,
	WRITE_CHUNK,
} from "../../../src/core/embed-cache.js";
import {
	DEFAULT_PROGRESS_TIMEOUT,
	IndexLock,
	isLockStale,
} from "../../../src/core/lock.js";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import type {
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../src/types.js";

/** The production property: a tenth of the hung threshold. */
const PRODUCTION_GAP_BOUND_MS = DEFAULT_PROGRESS_TIMEOUT / 10;
/**
 * `B_max` from `embed-cache.ts`'s THE ARITHMETIC — one contiguous region's worst
 * case. Guarantee 2 says a stamp happens at least that often.
 */
const REGION_GAP_BOUND_MS = 500;
/** Sampling period of the independent observer. */
const SAMPLE_MS = 20;

const MODEL = "nomic-embed-text";
const PROVIDER: EmbeddingProvider = "ollama";
const DIM = 64;

let dir: string;
let dbPath: string;
let lockPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-progress-"));
	dbPath = join(dir, "embed-cache.db");
	lockPath = join(dir, ".indexing.lock");
});

afterEach(() => {
	resetEmbedCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

/** Never called on a warm batch — which is exactly what makes Test A meaningful. */
class NeverCalledEmbedder implements IEmbeddingsClient {
	calls = 0;
	textsSeen: string[] = [];
	async embed(texts: string[]): Promise<EmbedResult> {
		this.calls++;
		this.textsSeen.push(...texts);
		return { embeddings: texts.map(() => vectorFor("unused")) };
	}
	async embedOne(): Promise<number[]> {
		this.calls++;
		return vectorFor("unused");
	}
	getModel(): string {
		return MODEL;
	}
	getDimension(): number | undefined {
		return undefined; // forces the cache's model_dims to answer
	}
	getProvider(): EmbeddingProvider {
		return PROVIDER;
	}
	isLocal(): boolean {
		return true;
	}
}

function vectorFor(text: string): number[] {
	const out: number[] = new Array(DIM);
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	}
	for (let i = 0; i < DIM; i++) {
		h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
		out[i] = (h % 20001) / 10000 - 1;
	}
	return out;
}

function open(): EmbedCache {
	const cache = openEmbedCache(dbPath);
	if (cache === null) throw new Error("openEmbedCache returned null");
	return cache;
}

/** Plant `count` warm rows directly, so setup costs no ticker and no yields. */
function warm(cache: EmbedCache, distinct: string[]): void {
	for (let i = 0; i < distinct.length; i += WRITE_CHUNK) {
		cache.putMany(
			distinct.slice(i, i + WRITE_CHUNK).map((text) => ({
				key: embedCacheKey(MODEL, DIM, text),
				model: MODEL,
				provider: PROVIDER,
				dimension: DIM,
				fingerprint: "",
				vector: vectorFor(text),
			})),
			[],
		);
	}
	cache.recordDimension(MODEL, PROVIDER, DIM);
}

/** Backdate every row past TOUCH_RESOLUTION_MS so the touch pass really writes. */
function backdate(): void {
	const db = createDatabaseSync(dbPath);
	try {
		const when = Date.now() - 10 * 60_000;
		db.prepare("UPDATE embeddings SET last_used_at = ?, created_at = ?").run(
			when,
			when,
		);
	} finally {
		db.close();
	}
}

/**
 * `LockData` is module-private in `lock.ts`, so the observer reads the file's
 * own JSON — which is what another process would do anyway. Only the fields
 * `isLockStale` decides on are needed.
 */
interface LockFile {
	pid: number;
	heartbeat: number;
	lastProgressAt?: number;
}

function readLock(): LockFile {
	return JSON.parse(readFileSync(lockPath, "utf-8")) as LockFile;
}

interface Observation {
	/** Longest wall-clock interval during which `lastProgressAt` did not move. */
	maxStampGapMs: number;
	/** How many distinct stamps the observer saw. */
	stamps: number;
	/** True if `isLockStale` ever returned true while the run was in flight. */
	everStale: boolean;
	samples: number;
	elapsedMs: number;
}

/**
 * Run `fn` while an INDEPENDENT timer samples the lock FILE.
 *
 * The observer is itself a timer, so a blocked event loop starves it too — but
 * the sample TIMESTAMPS are real wall clock, so an unchanged value across a
 * starved interval still reports the true width of that interval. That is the
 * same mechanism Phase 1's blocking probe uses, and it is why the assertion is a
 * gap in milliseconds rather than a count of missed samples.
 */
async function observe<T>(
	fn: () => Promise<T>,
): Promise<{ result: T } & Observation> {
	const t0 = performance.now();
	let lastValue = readLock().lastProgressAt ?? 0;
	let lastChangeAt = t0;
	let maxGap = 0;
	let stamps = 0;
	let samples = 0;
	let everStale = false;

	const timer = setInterval(() => {
		samples++;
		const lock = readLock();
		if (isLockStale(lock, 10_000, DEFAULT_PROGRESS_TIMEOUT)) everStale = true;
		const value = lock.lastProgressAt ?? 0;
		const now = performance.now();
		if (value !== lastValue) {
			maxGap = Math.max(maxGap, now - lastChangeAt);
			lastValue = value;
			lastChangeAt = now;
			stamps++;
		}
	}, SAMPLE_MS);

	try {
		const result = await fn();
		const end = performance.now();
		maxGap = Math.max(maxGap, end - lastChangeAt);
		return {
			result,
			maxStampGapMs: maxGap,
			stamps,
			everStale,
			samples,
			elapsedMs: end - t0,
		};
	} finally {
		clearInterval(timer);
	}
}

describe("§6.3 Test A — the hit path stamps the lock", () => {
	/**
	 * SIZING. `Indexer.FILES_PER_BATCH = 500`, so one `embedContentOf()` routinely
	 * carries thousands of chunks and the whole docs corpus arrives in one call.
	 * 50 000 is what makes the falsification decisive: with the ticker's emit
	 * removed, the scan runs 900+ ms without a single stamp, which is past the
	 * 500 ms region bound by ~2x. The design's 1 000 could not have failed — the
	 * whole scan is 10 ms at that size.
	 *
	 * The texts are 1 000 DISTINCT strings repeated 50 times: the array holds
	 * 50 000 references to 1 000 strings, so the workload is 50 000 real regions
	 * without 50 000 strings of memory. L0 is switched off so every one of them
	 * is a genuine SQLite lookup rather than a map hit.
	 */
	const DISTINCT = 1000;
	const REPEATS = 50;

	test("an ALL-HITS batch advances lastProgressAt throughout, and never goes stale", async () => {
		const cache = open();
		const distinct = Array.from(
			{ length: DISTINCT },
			(_, i) => `chunk-${i}-${"x".repeat(600)}`,
		);
		warm(cache, distinct);
		backdate();

		const input: string[] = new Array(DISTINCT * REPEATS);
		for (let i = 0; i < input.length; i++) {
			input[i] = distinct[i % DISTINCT] as string;
		}

		const fake = new NeverCalledEmbedder();
		const client = new CachingEmbeddingsClient({
			inner: fake,
			cache,
			mode: "persistent",
			clientFingerprint: "",
			memoryBudgetBytes: 0,
		});

		const lock = new IndexLock(dir, ".");
		const acquired = await lock.acquire();
		expect(acquired.acquired).toBe(true);

		try {
			const observed = await observe(() =>
				client.embed(input, () => {
					lock.recordProgress();
				}),
			);

			// The stamps can only have come from the HIT path.
			expect(fake.calls).toBe(0);
			expect(fake.textsSeen).toHaveLength(0);
			expect(observed.result.cacheHits).toBe(input.length);

			// It advanced, many times, and the observer really did observe.
			expect(observed.samples).toBeGreaterThan(5);
			expect(observed.stamps).toBeGreaterThan(10);

			// The production property...
			expect(observed.maxStampGapMs).toBeLessThan(PRODUCTION_GAP_BOUND_MS);
			// ...and the sensitive form of the same property: guarantee 2, as a
			// number. This is the assertion that goes red without the ticker.
			expect(observed.maxStampGapMs).toBeLessThan(REGION_GAP_BOUND_MS);

			expect(observed.everStale).toBe(false);
			expect(isLockStale(readLock(), 10_000, DEFAULT_PROGRESS_TIMEOUT)).toBe(
				false,
			);
		} finally {
			lock.release();
		}
	});

	test("the TRANSACTIONS stamp too — a touch-only putMany over 20 000 rows", async () => {
		// H7: covering the lookup loop is not covering the write. On an all-hits
		// batch there is nothing to insert, and the only SQLite work is the touch
		// pass — which is exactly the region a lookup-only ticker would leave
		// unstamped.
		const cache = open();
		const distinct = Array.from({ length: 20_000 }, (_, i) => `row-${i}`);
		warm(cache, distinct);
		backdate();

		const fake = new NeverCalledEmbedder();
		const client = new CachingEmbeddingsClient({
			inner: fake,
			cache,
			mode: "persistent",
			clientFingerprint: "",
			memoryBudgetBytes: 0,
		});

		const lock = new IndexLock(dir, ".");
		expect((await lock.acquire()).acquired).toBe(true);
		try {
			const observed = await observe(() =>
				client.embed(distinct, () => {
					lock.recordProgress();
				}),
			);
			expect(fake.calls).toBe(0);
			expect(observed.result.cacheHits).toBe(20_000);
			expect(observed.stamps).toBeGreaterThan(10);
			expect(observed.maxStampGapMs).toBeLessThan(PRODUCTION_GAP_BOUND_MS);
			expect(observed.maxStampGapMs).toBeLessThan(REGION_GAP_BOUND_MS);
			expect(observed.everStale).toBe(false);

			// And the touch really happened — bytes, not a report.
			const db = createDatabaseSync(dbPath);
			try {
				const row = db
					.prepare(
						"SELECT COUNT(*) AS n FROM embeddings WHERE last_used_at > created_at",
					)
					.get() as { n: number };
				expect(row.n).toBe(20_000);
			} finally {
				db.close();
			}
		} finally {
			lock.release();
		}
	});
});
