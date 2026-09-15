/**
 * V2.4 AT A REALISTIC EXPORT RATIO — every file exports.
 *
 * `indexer-heartbeat.test.ts` (V2.4) runs its corpus with `exportedFiles: 3`
 * out of 2 700. That keeps `resolveReferencesByName()` — one statement whose
 * cost, before the fix, was unresolved-references x EXPORTED symbols — near
 * free, so V2.4 could not fail on that hazard however badly the statement
 * planned. This file drives the SAME child (`indexer-heartbeat-child.ts`,
 * unmodified: it already takes the export count as an argument) with every
 * file exporting, sized so the pre-fix statement alone blocks well past
 * `DEFAULT_STALE_TIMEOUT`.
 *
 * THE HAZARD (CLAUDE.md #20, #27, #31). `isLockStale()`'s tighter rule is
 * `now - heartbeat > DEFAULT_STALE_TIMEOUT` (10 s), and `heartbeat` is written
 * ONLY by the holder's 1 s `setInterval`. A synchronous SQLite statement blocks
 * the event loop; one that runs longer than 10 s lets a second indexer reclaim
 * a lock a healthy process still holds. No caller-side yield can split ONE
 * statement, so the only defence is the statement's own plan
 * (`tracker-resolve-plan.test.ts` pins it).
 *
 * SIZING (Finding C: ~34 ns per reference x exported-symbol pair, linear in
 * both). 500 files x 40 exported functions = 20 000 exported symbols; each
 * function makes two calls, so run 1 hands the statement ~40 000 unresolved
 * references. Pre-fix that is tens of seconds in one statement; fixed, it is an
 * index probe per reference. See the falsification in the session log.
 *
 * WHAT IS MEASURED, AND BY WHOM — as in V2.4. The child only does the work and
 * reports row counts. THIS process, which never blocks, samples the lock
 * file's `heartbeat` from disk on its own `setInterval(…, 100)` and records its
 * own tick gaps. No self-report of blocking time (`stats()` or any other) is
 * used (CLAUDE.md #24).
 *
 * THE ASSERTION IS AN UPPER BOUND: any instant t while the lock is held lies
 * after some sample s with t - s ≤ the parent's longest tick gap, and
 * age(t) ≤ age(s) + (t - s), so
 *
 *     true max heartbeat age  ≤  max sampled age + max parent tick gap
 *
 * and that must stay below DEFAULT_STALE_TIMEOUT.
 */

import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
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

/** The parent's sampling interval, as V2.4's. */
const SAMPLE_MS = 100;

/**
 * EVERY file exports (`exportedFiles === files`). Run 2 is kept small: it
 * exists so the statement runs a second time, over references that stay
 * unresolved forever (the added files are non-exported, so calls to their own
 * functions never resolve) — the steady state of every later index run.
 */
const WORKLOAD = {
	files: 500,
	functionsPerFile: 40,
	exportedFiles: 500,
	delete: 20,
	modify: 20,
	add: 20,
	phantom: 200,
	/**
	 * Crash residue for run 2's R-recovery pass. Smaller than the sibling
	 * suite's: this test exists for `resolveReferencesByName`'s plan, and the
	 * residue is here so the child's argv stays one shape.
	 */
	residue: 200,
} as const;

/** Finding C's floor for "the hazard is really exercised". */
const MIN_EXPORTED_SYMBOLS = 15_000;
const MIN_REFERENCES_THROUGH_THE_STATEMENT = 20_000;

interface Sample {
	lock: string;
	ageMs: number;
	phase: string | undefined;
	token: string | undefined;
}

interface GraphCounts {
	exportedSymbols: number;
	resolvedReferences: number;
	unresolvedReferences: number;
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
	graph: GraphCounts | null;
	samples: Sample[];
	tornReads: number;
	maxTickGapMs: number;
	wallMs: number;
}

/** Every `index.db` under `dir` — the store's location is not assumed. */
function findIndexDbs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...findIndexDbs(path));
		else if (entry === "index.db") out.push(path);
	}
	return out;
}

/** Row counts the child's runs left behind: data, read after the fact. */
function readGraphCounts(sandbox: string): GraphCounts | null {
	const dbs = findIndexDbs(sandbox);
	if (dbs.length !== 1) return null;
	const db = createDatabaseSync(dbs[0] as string);
	try {
		const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
		return {
			exportedSymbols: count(
				"SELECT COUNT(*) AS n FROM symbols WHERE is_exported = 1",
			),
			resolvedReferences: count(
				"SELECT COUNT(*) AS n FROM symbol_references WHERE is_resolved = 1",
			),
			unresolvedReferences: count(
				"SELECT COUNT(*) AS n FROM symbol_references WHERE is_resolved = 0",
			),
		};
	} finally {
		db.close();
	}
}

/** Spawn the child and sample its lock files until it exits. */
async function measure(): Promise<Report> {
	const sandbox = mkdtempSync(join(tmpdir(), "mnemex-v2.4-exports-"));
	const home = join(sandbox, "home");
	const project = join(sandbox, "project");
	const started = performance.now();
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
				String(WORKLOAD.residue),
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
		let tornReads = 0;
		let maxTickGapMs = 0;
		let lastTick = performance.now();

		const timer = setInterval(() => {
			const tick = performance.now();
			maxTickGapMs = Math.max(maxTickGapMs, tick - lastTick);
			lastTick = tick;
			if (!locks) return;
			for (const [lock, path] of Object.entries(locks)) {
				let text: string;
				try {
					text = readFileSync(path, "utf8");
				} catch {
					continue; // not held: between runs, or before/after
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
			graph: exitCode === 0 ? readGraphCounts(sandbox) : null,
			samples,
			tornReads,
			maxTickGapMs,
			wallMs: performance.now() - started,
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

describe("V2.4 at a realistic export ratio — every file exports", () => {
	test("max heartbeat age, bounded from outside the child, stays below DEFAULT_STALE_TIMEOUT", async () => {
		const report = await measure();
		const store = report.samples.filter((s) => s.lock === "store");
		const maxAge = Math.max(0, ...store.map((s) => s.ageMs));
		const worst = store.find((s) => s.ageMs === maxAge);
		const upperBound = maxAge + report.maxTickGapMs;

		// Reported on every run, green or red, with the load it ran under.
		console.log(
			`V2.4-exports ${JSON.stringify({
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
				wallMs: Math.round(report.wallMs),
				runs: report.runs,
				state: report.state,
				graph: report.graph,
			})}`,
		);

		if (report.exitCode !== 0) {
			throw new Error(`child exited ${report.exitCode}:\n${report.stderr}`);
		}

		// ── Not vacuous: the child really did the pass, EVERY file exporting. ──
		expect(report.runs.map((r) => r.run)).toEqual([1, 2]);
		const [run1, run2] = report.runs;
		expect(run1?.filesIndexed).toBe(WORKLOAD.files);
		expect(run1?.errors).toBe(0);
		expect(run2?.filesIndexed).toBe(WORKLOAD.modify + WORKLOAD.add);
		expect(report.state?.phantomRemaining).toBe(0);
		expect(report.state?.trackedFiles).toBe(
			WORKLOAD.files - WORKLOAD.delete + WORKLOAD.add,
		);

		// ── Not vacuous: the statement really ran at the hazardous scale. ──────
		// Every resolved reference went through resolveReferencesByName() as an
		// unresolved one; exported symbols are what the pre-fix plan walked.
		const graph = report.graph;
		expect(graph).not.toBeNull();
		expect(graph?.exportedSymbols).toBeGreaterThanOrEqual(MIN_EXPORTED_SYMBOLS);
		expect(graph?.resolvedReferences).toBeGreaterThanOrEqual(
			MIN_REFERENCES_THROUGH_THE_STATEMENT,
		);
		// ...and some references stay unresolved for good (calls into the
		// non-exported added files), so run 2's pass had real misses to scan.
		expect(graph?.unresolvedReferences).toBeGreaterThan(0);

		// ── Not vacuous: this process really watched both runs. ────────────────
		expect(new Set(store.map((s) => s.token)).size).toBe(2);
		expect(store.length).toBeGreaterThanOrEqual(50);
		expect(report.maxTickGapMs).toBeLessThan(HEARTBEAT_INTERVAL);

		// ── The criterion. ─────────────────────────────────────────────────────
		expect(maxAge).toBeLessThan(DEFAULT_STALE_TIMEOUT);
		expect(upperBound).toBeLessThan(DEFAULT_STALE_TIMEOUT);
	}, 600_000);
});
