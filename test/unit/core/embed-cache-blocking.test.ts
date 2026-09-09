/**
 * §6.3 TEST B — event-loop starvation, the 10 s rule. Phase 1's half: B(b) and
 * B(c). (B(a), the proxy's all-hits `embed()`, arrives with Phase 2.)
 *
 * THE HAZARD. `isLockStale()` has two rules and the tighter one is
 * `now - heartbeat > DEFAULT_STALE_TIMEOUT` (10 s). `heartbeat` is written ONLY
 * by `startHeartbeat()`'s 1 s `setInterval`; `recordProgress()` writes
 * `lastProgressAt` and nothing else. Every SQLite call behind `sqlite.ts` is
 * synchronous, so it blocks the event loop, and a blocked loop cannot run that
 * interval. Exceed 10 s and a SECOND indexer reclaims a lock this process is
 * still holding. This repo has already paid for that mechanism once, with
 * `Bun.spawnSync` in place of SQLite (CLAUDE.md #27).
 *
 * HOW IT IS MEASURED. The blocking cannot be observed from inside the region
 * that causes it, so it is measured with THE SAME MECHANISM THE HEARTBEAT USES:
 * a `setInterval` whose tick times are recorded. Deliberately NOT asserted:
 * `stats().maxSyncRegionMs`, which is the class's self-report about its own
 * blocking — the same category as a millisecond budget standing in for a spawn
 * count (CLAUDE.md #24). The tick gap is the assertion.
 *
 * TWO PROBES, because one of them is insensitive at any workload a unit test
 * can afford:
 *
 *   - the 1 000 ms probe IS the heartbeat's own timer, asserted against the
 *     design's 2 500 ms bound (one missed interval plus slack, 4x inside the
 *     10 s rule). This is the property that matters in production.
 *   - the 20 ms probe measures the SAME event-loop blocking at 50x the
 *     resolution, asserted against `MAX_SYNC_REGION_MS` plus slack. This is what
 *     makes the test falsifiable at a size the suite can carry: a yield-free run
 *     of these workloads blocks for ~0.5-1 s, which is a flagrant violation of
 *     the per-region bound and yet slips under 2 500 ms unnoticed.
 *
 * FALSIFICATION (done, not claimed — see the session implementation log for the
 * pasted red output): each case was re-run with its own yield removed and the
 * 20 ms assertion went red; restoring the yield turned it green.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EmbedCache,
	EmbedCacheEntry,
} from "../../../src/core/embed-cache.js";
import {
	BUSY_TIMEOUT_MS,
	CONTENTION_BUDGET_MS,
	EVICT_CHUNK,
	embedCacheKey,
	LOOKUP_CHUNK,
	MAX_SYNC_REGION_MS,
	openEmbedCache,
	REGION_EVICT,
	REGION_LOOKUP,
	REGION_VACUUM,
	REGION_WRITE,
	resetEmbedCacheForTests,
	WRITE_CHUNK,
	yieldToEventLoop,
} from "../../../src/core/embed-cache.js";

/** The heartbeat's own interval, and the design's bound on one missed tick. */
const HEARTBEAT_PROBE_MS = 1000;
const HEARTBEAT_GAP_BOUND_MS = 2500;
/** The high-resolution probe, and the per-region bound plus scheduling slack. */
const FINE_PROBE_MS = 20;
const FINE_GAP_BOUND_MS = MAX_SYNC_REGION_MS + 150;

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-block-"));
	dbPath = join(dir, "embed-cache.db");
});

afterEach(() => {
	resetEmbedCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

interface Probed<T> {
	result: T;
	heartbeatGapMs: number;
	fineGapMs: number;
	elapsedMs: number;
}

/**
 * Run `fn` with two live intervals and report the longest interval during which
 * neither could run — i.e. the longest contiguous block of the event loop.
 * The start and end instants count as boundaries, so a block that swallows every
 * tick is still measured.
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

function open(options?: {
	maxBytes?: number;
	evictDeadlineMs?: number;
}): EmbedCache {
	const cache = openEmbedCache(dbPath, options);
	if (cache === null) throw new Error("openEmbedCache returned null");
	return cache;
}

function slice(from: number, to: number, dim: number): EmbedCacheEntry[] {
	const vector = Array.from({ length: dim }, (_, i) => i / dim);
	const out: EmbedCacheEntry[] = [];
	for (let i = from; i < to; i++) {
		out.push({
			key: embedCacheKey("m", dim, `text-${i}`),
			model: "m",
			provider: "ollama",
			dimension: dim,
			fingerprint: "",
			vector,
		});
	}
	return out;
}

// ════════════════════════════════════════════════════════════════════════════
describe("§6.3 B(b) — a large write, chunked at WRITE_CHUNK", () => {
	/**
	 * SIZING, and why it is not the 20 000 the design wrote down. §6.3 argues
	 * exactly this for case (a): 5 000 "was small enough that revision 1's
	 * yield-free R1 might have passed". The same reasoning binds here — measured
	 * on this machine, 20 000 rows of 768 dims is 440 ms of work, and a
	 * yield-free run of that is a REAL violation of the per-region bound that
	 * nonetheless passes a 2 500 ms assertion. 60 000 rows makes the yield-free
	 * run ~1 s, decisively over the 400 ms per-region bound, while writing only
	 * 48 MB.
	 *
	 * The yields are in the CALLER here, because `putMany` deliberately does not
	 * loop — it is one bounded transaction and the chunking is the caller's job
	 * (Phase 2's `flushWrites` is the single caller that will implement exactly
	 * this shape). What this test pins is that the discipline WORKS: with it, a
	 * 60 000-row write never blocks the loop past one region.
	 */
	const ROWS = 60_000;
	const DIM = 128;

	test("the event loop stays live through a 60 000-row write", async () => {
		const cache = open();
		const probed = await withProbes(async () => {
			let written = 0;
			for (let i = 0; i < ROWS; i += WRITE_CHUNK) {
				cache.putMany(slice(i, Math.min(i + WRITE_CHUNK, ROWS), DIM), []);
				written += Math.min(WRITE_CHUNK, ROWS - i);
				await yieldToEventLoop();
			}
			return written;
		});
		expect(probed.result).toBe(ROWS);
		expect(cache.stats().writes).toBe(ROWS);

		// The property that matters in production, on the heartbeat's own timer.
		expect(probed.heartbeatGapMs).toBeLessThan(HEARTBEAT_GAP_BOUND_MS);
		// The sensitive form of the same property.
		expect(probed.fineGapMs).toBeLessThan(FINE_GAP_BOUND_MS);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("§6.3 B(c) — eviction on an over-cap cache", () => {
	/**
	 * Here the yields are in PRODUCTION code — `enforceBudget` owns its own R3/R4
	 * loop — so removing them is a real falsification of the shipped mechanism.
	 * Measured with both `await yieldToEventLoop()` calls deleted from the evict
	 * loop: 30 000 rows blocked for under the bound and passed (the sweep is only
	 * ~300 ms of work at that size), 60 000 rows blocked for 837 ms and failed.
	 * The heartbeat probe passed in BOTH cases, which is the whole argument for
	 * the second probe.
	 */
	const ROWS = 60_000;
	const DIM = 128;

	test("the event loop stays live through a full LRU sweep", async () => {
		const cache = open({ maxBytes: 512 * 1024 });
		for (let i = 0; i < ROWS; i += WRITE_CHUNK) {
			cache.putMany(slice(i, Math.min(i + WRITE_CHUNK, ROWS), DIM), []);
		}

		const probed = await withProbes(() => cache.enforceBudget());
		expect(probed.result.rowsEvicted).toBeGreaterThan(0);
		expect(probed.result.fileBytesAfter).toBeLessThan(
			probed.result.fileBytesBefore,
		);

		expect(probed.heartbeatGapMs).toBeLessThan(HEARTBEAT_GAP_BOUND_MS);
		expect(probed.fineGapMs).toBeLessThan(FINE_GAP_BOUND_MS);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("R1 — a long lookup scan, chunked at LOOKUP_CHUNK", () => {
	/**
	 * The region revision 1 omitted entirely. `N` is the caller's batch size, not
	 * a constant: `Indexer.FILES_PER_BATCH = 500`, so one `embedContentOf()`
	 * routinely carries thousands of chunks and the whole docs corpus arrives in
	 * one call. Phase 2 owns that loop (§6.3 B(a)); what this pins is that the
	 * LOOKUP_CHUNK discipline is sufficient for it.
	 *
	 * SIZING. A point lookup on the primary key is fast — 3.6 µs at 64 dims — so
	 * the design's 25 000 CANNOT falsify anything here: measured, the whole
	 * yield-free scan is 90 ms, which no bound in this file would catch. At 768
	 * dims (the real width, where each hit also decodes 3 072 bytes) 40 000
	 * lookups reach 447 ms, still only 12 % past the bound. 80 000 makes the
	 * yield-free run 1 128 ms, i.e. 2.8x the bound — a margin a loaded machine
	 * cannot close by accident.
	 */
	test("the event loop stays live through 80 000 lookups", async () => {
		const cache = open();
		const dim = 768;
		cache.putMany(slice(0, 1000, dim), []);
		const keys = slice(0, 1000, dim).map((e) => e.key);

		const probed = await withProbes(async () => {
			let seen = 0;
			for (let i = 0; i < 80_000; i++) {
				cache.get(keys[i % keys.length] as string, "ollama", dim, "");
				seen++;
				if ((i + 1) % LOOKUP_CHUNK === 0) await yieldToEventLoop();
			}
			return seen;
		});
		expect(probed.result).toBe(80_000);
		expect(cache.stats().hits).toBe(80_000);
		expect(probed.heartbeatGapMs).toBeLessThan(HEARTBEAT_GAP_BOUND_MS);
		expect(probed.fineGapMs).toBeLessThan(FINE_GAP_BOUND_MS);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("§6.3 C — the constants cannot drift", () => {
	/**
	 * `DEFAULT_STALE_TIMEOUT` and `HEARTBEAT_INTERVAL` are module-private in
	 * `lock.ts` and cannot be imported without widening `embed-cache.ts`'s import
	 * list, so they are read from that file's SOURCE. That is deliberate and
	 * stronger than an import would be: an edit to either constant, or a rename
	 * that hides one, fails this test rather than silently re-basing the
	 * arithmetic that the whole §6.2 bound rests on.
	 */
	function lockConstant(name: string): number {
		const source = readFileSync(
			join(import.meta.dir, "..", "..", "..", "src", "core", "lock.ts"),
			"utf8",
		);
		const match = new RegExp(
			`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)`,
		).exec(source);
		if (match?.[1] === undefined) {
			throw new Error(`lock.ts no longer declares ${name}`);
		}
		return Number(match[1]);
	}

	test("lock.ts still declares the three constants the bound is derived from", () => {
		expect(lockConstant("DEFAULT_STALE_TIMEOUT")).toBe(10000);
		expect(lockConstant("DEFAULT_PROGRESS_TIMEOUT")).toBe(300000);
		expect(lockConstant("HEARTBEAT_INTERVAL")).toBe(1000);
	});

	test("B_max + HEARTBEAT_INTERVAL is comfortably inside DEFAULT_STALE_TIMEOUT", () => {
		const stale = lockConstant("DEFAULT_STALE_TIMEOUT");
		const heartbeat = lockConstant("HEARTBEAT_INTERVAL");

		// The MECHANISM's bound: one region's busy-wait is capped at
		// BUSY_TIMEOUT_MS by the divided clamp, whatever the process budget does.
		const bMax = BUSY_TIMEOUT_MS + MAX_SYNC_REGION_MS;
		expect(bMax).toBe(500);
		expect(bMax + heartbeat + 1).toBeLessThan(stale);
		expect(bMax + heartbeat).toBeLessThan(stale / 2);

		// The design's older, looser form — kept because a future edit that raises
		// CONTENTION_BUDGET_MS should still have to face it.
		expect(CONTENTION_BUDGET_MS + MAX_SYNC_REGION_MS + heartbeat).toBeLessThan(
			stale / 2,
		);
	});

	test("every region's divided clamp bounds the region at BUSY_TIMEOUT_MS", () => {
		for (const region of [
			REGION_LOOKUP,
			REGION_WRITE,
			REGION_EVICT,
			REGION_VACUUM,
		]) {
			const perStatement = Math.floor(
				BUSY_TIMEOUT_MS / region.blockingStatements,
			);
			expect(region.blockingStatements * perStatement).toBeLessThanOrEqual(
				BUSY_TIMEOUT_MS,
			);
		}
	});

	test("the size constants are the ones the arithmetic assumes", () => {
		expect(LOOKUP_CHUNK).toBe(REGION_LOOKUP.blockingStatements);
		expect(WRITE_CHUNK).toBe(256);
		expect(EVICT_CHUNK).toBe(512);
	});
});
