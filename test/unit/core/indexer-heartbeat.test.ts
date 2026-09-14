/**
 * V2.4 — the store lock's heartbeat stays fresh while the REAL indexer loops
 * run their tracker regions, MEASURED FROM OUTSIDE the process that blocks.
 *
 * THE HAZARD (CLAUDE.md #20, #27, #31). `isLockStale()` has two rules and the
 * tighter one is `now - heartbeat > DEFAULT_STALE_TIMEOUT` (10 s). `heartbeat`
 * is written ONLY by the holder's 1 s `setInterval`. Every tracker call is a
 * synchronous SQLite region, and tree-sitter parsing is synchronous too, so a
 * loop that runs them back to back without returning to the event loop's
 * TIMERS phase starves that interval — and a second indexer then reclaims a
 * lock that a healthy process still holds. `tracker.ts` bounds each region
 * (`sync-region.ts`, THE ARITHMETIC); that bound composes into a heartbeat
 * bound only if the CALLER yields between regions (SR-2).
 *
 * WHAT IS MEASURED, AND BY WHOM. The child (`indexer-heartbeat-child.ts`) runs
 * `Indexer.index()` twice over a synthetic project and only reports what it
 * did. This process — which never blocks — samples the lock file's `heartbeat`
 * field from disk on its own `setInterval(…, 100)` and records its own tick
 * gaps. Deliberately NOT used: `stats().maxSyncRegionMs` or any other
 * self-report of blocking time (CLAUDE.md #24: a millisecond self-report
 * standing in for the real thing passed in isolation and failed under load).
 *
 * THE ASSERTION IS AN UPPER BOUND, not just the largest sample. Any instant t
 * while the lock is held lies after some sample s ≤ t with t - s ≤ the
 * parent's longest tick gap, and age(t) ≤ age(s) + (t - s). So
 *
 *     true max heartbeat age  ≤  max sampled age + max parent tick gap
 *
 * and THAT is what must stay below DEFAULT_STALE_TIMEOUT.
 *
 * EXPECTED, from `sync-region.ts`: HEARTBEAT_INTERVAL + B_max + 1 = 1501 ms for
 * the SQLite regions, margin 8499 ms. Parsing blocks too — one file's parse
 * per yield here — so the observed maximum is reported per phase.
 *
 * COVERAGE, honestly. The regions that exist in `tracker.ts` after Phase 2B
 * are R0 (open), R1 (`getChanges`), R-read, R-write and R-txn; this run drives
 * all five through the indexer's own loops. The architecture's R2, R5a/R5b,
 * R6, R7 and `R-recovery` belong to tables Phase 3b creates. They are NOT
 * stubbed here — a region that does nothing measures nothing — and V2.4 must
 * be re-run over them when they exist.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(REPO, "test", "helpers", "indexer-heartbeat-child.ts");

/**
 * `lock.ts` keeps these module-private; re-read from its SOURCE so the test
 * cannot drift from the value `isLockStale()` actually uses.
 */
function lockConstant(name: string): number {
	const source = readFileSync(join(REPO, "src", "core", "lock.ts"), "utf8");
	const match = source.match(new RegExp(`const ${name} = (\\d+)`));
	if (!match?.[1]) throw new Error(`lock.ts: ${name} not found`);
	return Number(match[1]);
}
const DEFAULT_STALE_TIMEOUT = lockConstant("DEFAULT_STALE_TIMEOUT");
const HEARTBEAT_INTERVAL = lockConstant("HEARTBEAT_INTERVAL");

/** The parent's sampling interval — V2.4's `setInterval(…, 100)`. */
const SAMPLE_MS = 100;

/**
 * The synthetic pass. 2 700 files × 40 functions, EVERY ONE EXPORTED. Measured
 * in run 1: 216 000 chunks and ~104 000 symbols — above the criterion's 50 000
 * — and a symbol-extraction phase whose parse alone takes well over 10 s
 * unyielded, so deleting its yields breaches the stale rule (the falsifier).
 * 2 000 phantom tracker rows give the deleted-files loop 2 000 iterations of
 * nothing but tracker regions.
 *
 * Every file exports because `tracker.ts`'s `resolveReferencesByName()` scales
 * with EXPORTED symbols, and a pass that exported almost nothing would not
 * measure it. This test used to run with 3 exporting files, because that one
 * UPDATE's two correlated subqueries were planned through the partial index
 * `idx_symbols_exported` and cost unresolved-references × exported symbols
 * inside ONE synchronous statement: with every function exported it starved
 * the heartbeat for 590 s, and no caller-side yield can split a statement. The
 * plan is now pinned by `EXPLAIN QUERY PLAN` in `tracker-resolve-plan.test.ts`.
 * `indexer-heartbeat-exports.test.ts` measures the same statement at 500 files
 * and also asserts how many references it resolved, which this test cannot see.
 */
const FILES = 2700;
const WORKLOAD = {
	files: FILES,
	functionsPerFile: 40,
	exportedFiles: FILES,
	delete: 100,
	modify: 100,
	add: 100,
	phantom: 2000,
} as const;

interface Sample {
	lock: string;
	at: number;
	ageMs: number;
	phase: string | undefined;
	token: string | undefined;
}

interface Report {
	exitCode: number;
	stderr: string;
	runs: Array<{
		run: number;
		filesIndexed: number;
		chunksCreated: number;
		errors: number;
	}>;
	state: {
		symbols: number;
		references: number;
		trackedFiles: number;
		phantomRemaining: number;
	} | null;
	samples: Sample[];
	absentReads: number;
	tornReads: number;
	maxTickGapMs: number;
	ticks: number;
}

/** Spawn the child and sample its lock files until it exits. */
async function measure(): Promise<Report> {
	const sandbox = mkdtempSync(join(tmpdir(), "mnemex-v2.4-"));
	const home = join(sandbox, "home");
	const project = join(sandbox, "project");
	try {
		const proc = Bun.spawn(
			[
				"bun",
				CHILD,
				project,
				String(WORKLOAD.files),
				String(WORKLOAD.functionsPerFile),
				String(WORKLOAD.exportedFiles),
				String(WORKLOAD.delete),
				String(WORKLOAD.modify),
				String(WORKLOAD.add),
				String(WORKLOAD.phantom),
			],
			{
				// Not the repo: bun auto-loads a `.env` from the cwd (CLAUDE.md #23).
				cwd: sandbox,
				stdout: "pipe",
				stderr: "pipe",
				env: keychainSafeChildEnv({
					HOME: home,
					MNEMEX_TEST_SANDBOX_HOME: home,
					MNEMEX_EMBED_CACHE_PATH: join(sandbox, "embed-cache.db"),
					MNEMEX_GLOBAL_LOCK_PATH: join(sandbox, "global-indexing.lock"),
					MNEMEX_DOCS_ENABLED: "0",
				}),
			},
		);

		const runs: Report["runs"] = [];
		let state: Report["state"] = null;
		let locks: Record<string, string> | null = null;
		const samples: Sample[] = [];
		let absentReads = 0;
		let tornReads = 0;
		let ticks = 0;
		let maxTickGapMs = 0;
		let lastTick = performance.now();

		const timer = setInterval(() => {
			const tick = performance.now();
			maxTickGapMs = Math.max(maxTickGapMs, tick - lastTick);
			lastTick = tick;
			ticks++;
			if (!locks) return;
			for (const [lock, path] of Object.entries(locks)) {
				let text: string;
				try {
					text = readFileSync(path, "utf8");
				} catch {
					absentReads++; // not held: between runs, or before/after
					continue;
				}
				const now = Date.now();
				try {
					const data = JSON.parse(text) as {
						pid?: number;
						heartbeat?: number;
						phase?: string;
						token?: string;
					};
					if (data.pid !== proc.pid || typeof data.heartbeat !== "number") {
						continue;
					}
					samples.push({
						lock,
						at: now,
						ageMs: now - data.heartbeat,
						phase: data.phase,
						token: data.token,
					});
				} catch {
					tornReads++;
				}
			}
		}, SAMPLE_MS);

		const readStdout = (async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of proc.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					const space = line.indexOf(" ");
					const tag = line.slice(0, space);
					const body = line.slice(space + 1);
					if (tag === "LOCKS") locks = JSON.parse(body);
					else if (tag === "RUN") runs.push(JSON.parse(body));
					else if (tag === "STATE") state = JSON.parse(body);
					newline = buffered.indexOf("\n");
				}
			}
		})();
		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
			readStdout,
		]);
		clearInterval(timer);

		return {
			exitCode,
			stderr,
			runs,
			state,
			samples,
			absentReads,
			tornReads,
			maxTickGapMs,
			ticks,
		};
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

/** Max sampled age per lock-file phase: where any blocking happened. */
function agesByPhase(samples: Sample[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of samples) {
		const phase = s.phase ?? "(none)";
		out[phase] = Math.max(out[phase] ?? 0, Math.round(s.ageMs));
	}
	return out;
}

describe("V2.4 — heartbeat age while the indexer's regions run under the store lock", () => {
	test("max heartbeat age, bounded from outside the child, stays below DEFAULT_STALE_TIMEOUT", async () => {
		const report = await measure();
		const store = report.samples.filter((s) => s.lock === "store");
		const maxAge = Math.max(0, ...store.map((s) => s.ageMs));
		const worst = store.find((s) => s.ageMs === maxAge);
		const upperBound = maxAge + report.maxTickGapMs;

		// Reported on every run, green or red, with the load it ran under.
		console.log(
			`V2.4 ${JSON.stringify({
				loadavg: loadavg().map((l) => Number(l.toFixed(2))),
				maxSampledAgeMs: Math.round(maxAge),
				atPhase: worst?.phase,
				maxParentTickGapMs: Math.round(report.maxTickGapMs),
				upperBoundMs: Math.round(upperBound),
				staleTimeoutMs: DEFAULT_STALE_TIMEOUT,
				marginMs: Math.round(DEFAULT_STALE_TIMEOUT - upperBound),
				heldSamples: store.length,
				byPhase: agesByPhase(store),
				globalLockMaxAgeMs: Math.round(
					Math.max(
						0,
						...report.samples
							.filter((s) => s.lock === "global")
							.map((s) => s.ageMs),
					),
				),
				tornReads: report.tornReads,
				runs: report.runs,
				state: report.state,
			})}`,
		);

		if (report.exitCode !== 0) {
			throw new Error(`child exited ${report.exitCode}:\n${report.stderr}`);
		}

		// ── Not vacuous: the child really did the synthetic pass. ──────────
		expect(report.runs.map((r) => r.run)).toEqual([1, 2]);
		const [run1, run2] = report.runs;
		expect(run1?.filesIndexed).toBe(WORKLOAD.files);
		expect(run1?.chunksCreated).toBeGreaterThanOrEqual(50_000);
		expect(run2?.filesIndexed).toBe(WORKLOAD.modify + WORKLOAD.add);
		expect(report.state?.symbols).toBeGreaterThanOrEqual(50_000);
		// Every phantom row went through the deleted-files loop's two regions.
		expect(report.state?.phantomRemaining).toBe(0);
		expect(report.state?.trackedFiles).toBe(
			WORKLOAD.files - WORKLOAD.delete + WORKLOAD.add,
		);

		// ── Not vacuous: this process really watched both runs. ────────────
		// Two holds of the store lock, each with its own ownership token.
		expect(new Set(store.map((s) => s.token)).size).toBe(2);
		// At least 5 s of held-lock sampling in total.
		expect(store.length).toBeGreaterThanOrEqual(50);
		// The watcher itself was never starved long enough to miss a breach.
		expect(report.maxTickGapMs).toBeLessThan(HEARTBEAT_INTERVAL);

		// ── The criterion. ─────────────────────────────────────────────────
		expect(maxAge).toBeLessThan(DEFAULT_STALE_TIMEOUT);
		expect(upperBound).toBeLessThan(DEFAULT_STALE_TIMEOUT);
	}, 600_000);
});
