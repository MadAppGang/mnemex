/**
 * §6.3 TEST B(a) — event-loop starvation on the PROXY's all-hits `embed()`.
 *
 * Phase 1 covered B(b) (a large write) and B(c) (an LRU sweep) in
 * `embed-cache-blocking.test.ts`. B(a) is the case that only exists once the
 * proxy does — region R1, the lookup loop — and §6.3 names it as the one
 * revision 1 would have failed, because revision 1 had no yield in it at all.
 *
 * THE HAZARD. `isLockStale`'s SECONDARY rule is `now - heartbeat > 10 000 ms`,
 * and `heartbeat` is written ONLY by a 1 s `setInterval` (`lock.ts:592-606`).
 * Every SQLite call behind `sqlite.ts` is synchronous, so a yield-free scan of
 * one `embedContentOf()` batch — `Indexer.FILES_PER_BATCH = 500` files' worth of
 * chunks, or the whole docs corpus in one call — blocks that timer. A second
 * indexer then reclaims a held lock. Same mechanism as CLAUDE.md #27, with
 * synchronous SQLite in place of `Bun.spawnSync`.
 *
 * HOW IT IS MEASURED, and why there are two probes. Copied deliberately from
 * `embed-cache-blocking.test.ts` so the two halves of Test B are measured the
 * same way:
 *
 *   - the 1 000 ms probe IS the heartbeat's own timer, asserted against the
 *     design's 2 500 ms bound. This is the production property.
 *   - the 20 ms probe measures the SAME blocking at 50x the resolution,
 *     asserted against `MAX_SYNC_REGION_MS` plus slack. It is what makes the
 *     test falsifiable at a size the suite can carry: measured here, a
 *     yield-free scan blocks ~1.1 s, which is a flagrant violation of the
 *     per-region bound and yet slips under 2 500 ms unnoticed.
 *
 * Deliberately NOT asserted: `stats().maxSyncRegionMs`. That is the class's
 * self-report about its own blocking — the same category as a millisecond budget
 * standing in for a spawn count (CLAUDE.md #24). The tick gap is the assertion.
 *
 * FALSIFIED: re-run with the `await yieldToEventLoop()` removed from the proxy's
 * lookup loop; the 20 ms assertion goes red. Red output in the session log.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import type { EmbedCache } from "../../../src/core/embed-cache.js";
import {
	embedCacheKey,
	MAX_SYNC_REGION_MS,
	openEmbedCache,
	resetEmbedCacheForTests,
	WRITE_CHUNK,
} from "../../../src/core/embed-cache.js";
import type {
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../src/types.js";

const HEARTBEAT_PROBE_MS = 1000;
const HEARTBEAT_GAP_BOUND_MS = 2500;
const FINE_PROBE_MS = 20;
const FINE_GAP_BOUND_MS = MAX_SYNC_REGION_MS + 150;

const MODEL = "nomic-embed-text";
const PROVIDER: EmbeddingProvider = "ollama";
const DIM = 256;

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "caching-embed-block-"));
	dbPath = join(dir, "embed-cache.db");
});

afterEach(() => {
	resetEmbedCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

class NeverCalledEmbedder implements IEmbeddingsClient {
	calls = 0;
	async embed(texts: string[]): Promise<EmbedResult> {
		this.calls++;
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
		return undefined;
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

interface Probed<T> {
	result: T;
	heartbeatGapMs: number;
	fineGapMs: number;
	elapsedMs: number;
}

/**
 * Run `fn` with two live intervals and report the longest interval during which
 * neither could run — the longest contiguous block of the event loop. The start
 * and end instants count as boundaries, so a block that swallows every tick is
 * still measured.
 */
async function withProbes<T>(fn: () => Promise<T>): Promise<Probed<T>> {
	const heartbeat: number[] = [performance.now()];
	const fine: number[] = [performance.now()];
	const t0 = performance.now();
	const h = setInterval(
		() => heartbeat.push(performance.now()),
		HEARTBEAT_PROBE_MS,
	);
	const f = setInterval(() => fine.push(performance.now()), FINE_PROBE_MS);
	try {
		const result = await fn();
		const end = performance.now();
		heartbeat.push(end);
		fine.push(end);
		const maxGap = (marks: number[]) => {
			let max = 0;
			for (let i = 1; i < marks.length; i++) {
				max = Math.max(max, (marks[i] as number) - (marks[i - 1] as number));
			}
			return max;
		};
		return {
			result,
			heartbeatGapMs: maxGap(heartbeat),
			fineGapMs: maxGap(fine),
			elapsedMs: end - t0,
		};
	} finally {
		clearInterval(h);
		clearInterval(f);
	}
}

describe("§6.3 B(a) — an all-hits embed() through the proxy", () => {
	/**
	 * SIZING, and why it is not the design's 25 000. §6.3 argues the point for
	 * this very case — 5 000 "was small enough that revision 1's yield-free R1
	 * might have passed" — and the same reasoning binds one step further. Measured
	 * on this machine with the yield REMOVED, at 4 000-character texts:
	 *
	 *     n =  60 000, dim  64 -> 238 ms   PASSES the 400 ms bound. Proves nothing.
	 *     n =  60 000, dim 256 -> 444 ms   1.1x. Too thin for a faster machine.
	 *     n = 100 000, dim 256 -> 811 ms   2.0x. Chosen.
	 *
	 * With the yield in place the same run measures 22 ms, an 18x margin the other
	 * way, so the test is not near either edge. `dim = 256` is what buys the
	 * margin without buying memory: it makes each region decode a 1 KB blob
	 * instead of a 256-byte one, which is real work rather than more items.
	 *
	 * 2 000 DISTINCT texts repeated 50 times: the array holds 100 000 references
	 * to 2 000 strings, so this is 100 000 real regions without 100 000 strings of
	 * memory. L0 is switched OFF (`memoryBudgetBytes: 0`) so every one of them is
	 * a genuine SQLite lookup rather than a map hit — otherwise the repeats would
	 * make the workload evaporate.
	 */
	const DISTINCT = 2000;
	const REPEATS = 50;

	test("the event loop stays live through 100 000 cache lookups", async () => {
		const cache = open();
		const distinct = Array.from(
			{ length: DISTINCT },
			(_, i) => `chunk-${i}-${"x".repeat(4000)}`,
		);
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

		const probed = await withProbes(() => client.embed(input));

		// The run really was all hits — otherwise this measures the fake, not R1.
		expect(fake.calls).toBe(0);
		expect(probed.result.cacheHits).toBe(input.length);
		expect(probed.result.embeddings).toHaveLength(input.length);

		// The property that matters in production, on the heartbeat's own timer.
		expect(probed.heartbeatGapMs).toBeLessThan(HEARTBEAT_GAP_BOUND_MS);
		// The sensitive form of the same property.
		expect(probed.fineGapMs).toBeLessThan(FINE_GAP_BOUND_MS);
	});
});
