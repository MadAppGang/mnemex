/**
 * V2.8 and V2.11 — a SECOND PROCESS on a tracker `index.db` that another
 * process is writing to.
 *
 * While every worktree owned its own `index.db`, nothing else wrote to it. Once
 * the file is shared, `FileTracker`'s constructor DDL and every statement after
 * it contend with other processes. `src/core/tracker.ts` answers with WAL on
 * its own connection (never in `sqlite.ts`'s shared opener — V2.9) and a
 * divided `busy_timeout` clamp per region (CLAUDE.md #31).
 *
 * THE EVIDENCE RULES this file keeps (CLAUDE.md #24, #25, #31):
 *   - the adversary is a real child PROCESS (`tracker-contention-child.cjs`),
 *     built with `keychainSafeChildEnv()`, with `HOME` and
 *     `MNEMEX_EMBED_CACHE_PATH` inside `mkdtemp`;
 *   - blocking is measured from OUTSIDE: the child appends a timestamp every
 *     10 ms, the parent reads the file and takes the longest gap. Never the
 *     class's report about itself;
 *   - what was written is read back through an INDEPENDENT connection.
 *
 * The holder is a raw connection in THIS process, holding a write transaction
 * across the whole child run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import {
	BUSY_TIMEOUT_MS,
	MAX_SYNC_REGION_MS,
} from "../../../src/core/sync-region.js";
import {
	FileTracker,
	resetTrackerSchemaCache,
	TRACKER_CONTENTION_BUDGET_MS,
} from "../../../src/core/tracker.js";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(REPO, "test", "helpers", "tracker-contention-child.cjs");
const TRACKER_MODULE = join(REPO, "src", "core", "tracker.ts");

/**
 * B_max from `sync-region.ts`'s THE ARITHMETIC: one region's busy-wait (≤ 250)
 * plus its work target (250). The longest block any single region may cause.
 */
const B_MAX_MS = BUSY_TIMEOUT_MS + MAX_SYNC_REGION_MS;

/** Process spawn + a bun build of the tracker leaves the default 5 s tight. */
const CHILD_TEST_TIMEOUT_MS = 30_000;

let dir: string;
let home: string;
let root: string;
let dbPath: string;
let runSeq = 0;
const bundles: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tracker-concurrency-"));
	home = join(dir, "home");
	root = join(dir, "repo");
	mkdirSync(home);
	mkdirSync(root);
	dbPath = join(root, ".mnemex", "index.db");
	resetTrackerSchemaCache();
});

afterEach(() => {
	resetTrackerSchemaCache();
	rmSync(dir, { recursive: true, force: true });
	for (const bundle of bundles.splice(0)) rmSync(bundle, { force: true });
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface ChildError {
	name: string | null;
	message: string;
	code: string | null;
	region: string | null;
}

interface ChildResult {
	runtime: { bun: string | null; node: string };
	mode: string;
	constructed?: boolean;
	error: ChildError | null;
	journalMode?: string;
	seed?: string | null;
	pending?: string | null;
	restingBusyTimeout?: number | null;
	rows?: number | null;
	attempts?: Array<{ ok: boolean; ms: number; error: ChildError | null }>;
	fatal?: ChildError;
}

interface ChildRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	result: ChildResult;
	/** Longest gap between two of the child's 10 ms ticks, read from outside. */
	maxBeatGapMs: number;
	beats: number;
}

function childEnv(): Record<string, string> {
	return keychainSafeChildEnv({
		HOME: home,
		MNEMEX_EMBED_CACHE_PATH: join(home, "embed-cache.db"),
	});
}

/** `node` on the PATH a child inherits — present on CI and after `npm i`. */
function nodeAvailable(): boolean {
	const probe = spawnSync("node", ["--version"], {
		encoding: "utf8",
		env: keychainSafeChildEnv(),
	});
	return probe.status === 0;
}

/**
 * A CJS bundle of the tracker for Node, so the child runs better-sqlite3.
 * Inside the repo: Node resolves `better-sqlite3` from the requiring FILE.
 */
function buildNodeBundle(): string {
	const bundleDir = join(
		REPO,
		"node_modules",
		".cache",
		"mnemex-tracker-drivers",
	);
	mkdirSync(bundleDir, { recursive: true });
	const bundle = join(bundleDir, `tracker-${process.pid}-${runSeq++}.cjs`);
	bundles.push(bundle);
	const build = spawnSync(
		"bun",
		[
			"build",
			TRACKER_MODULE,
			"--target",
			"node",
			"--format",
			"cjs",
			"--external",
			"better-sqlite3",
			"--outfile",
			bundle,
		],
		{ encoding: "utf8", cwd: REPO, env: keychainSafeChildEnv() },
	);
	expect(build.status, build.stderr).toBe(0);
	expect(existsSync(bundle)).toBe(true);
	return bundle;
}

/**
 * Run the child to completion. When it prints `READY`, `onReady` runs (the
 * parent's move) and then the go-file is written.
 */
async function runChild(
	runtime: "bun" | "node",
	module: string,
	mode: string,
	onReady?: () => void,
	extraArgs: string[] = [],
): Promise<ChildRun> {
	const tag = `${mode}-${runSeq++}`;
	const beatFile = join(dir, `beat-${tag}.txt`);
	const goFile = join(dir, `go-${tag}`);
	// `--env-file=/dev/null`: bun would otherwise load the cwd's `.env` (#23).
	const argv =
		runtime === "bun"
			? [process.execPath, "--env-file=/dev/null", CHILD]
			: ["node", CHILD];
	const proc = Bun.spawn(
		[...argv, module, mode, dbPath, root, beatFile, goFile, ...extraArgs],
		{ cwd: REPO, env: childEnv(), stdout: "pipe", stderr: "pipe" },
	);

	let stdout = "";
	let readyHandled = false;
	const decoder = new TextDecoder();
	const reader = proc.stdout.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		stdout += decoder.decode(value, { stream: true });
		if (!readyHandled && /^READY /m.test(stdout)) {
			readyHandled = true;
			onReady?.();
			writeFileSync(goFile, "go");
		}
	}
	const exitCode = await proc.exited;
	const stderr = await new Response(proc.stderr).text();

	const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
	if (line === undefined) {
		throw new Error(
			`child printed no result (exit ${exitCode}):\n${stdout}\n${stderr}`,
		);
	}
	const result = JSON.parse(line.slice("__RESULT__".length)) as ChildResult;
	if (result.fatal) {
		throw new Error(
			`child harness fault: ${JSON.stringify(result.fatal)}\n${stderr}`,
		);
	}

	const beats = readFileSync(beatFile, "utf8").trim().split("\n").map(Number);
	let maxBeatGapMs = 0;
	for (let i = 1; i < beats.length; i++) {
		maxBeatGapMs = Math.max(
			maxBeatGapMs,
			(beats[i] as number) - (beats[i - 1] as number),
		);
	}
	return {
		exitCode,
		stdout,
		stderr,
		result,
		maxBeatGapMs,
		beats: beats.length,
	};
}

/** A tracker database as a first process left it. */
function seedTracker(files: string[] = []): void {
	const tracker = new FileTracker(dbPath, root);
	tracker.setMetadata("seed", "committed");
	for (const file of files) {
		tracker.markIndexed(0, join(root, file), `hash-${file}`, [`chunk-${file}`]);
	}
	tracker.close();
}

/** Rows and mode through a connection that is neither the holder nor the child. */
function inspect(sql: string): unknown[] {
	const db = createDatabaseSync(dbPath);
	try {
		return db.prepare(sql).all();
	} finally {
		db.close();
	}
}

// ════════════════════════════════════════════════════════════════════════════
// V2.8
// ════════════════════════════════════════════════════════════════════════════

describe("V2.8 — constructing FileTracker while another process holds a write transaction", () => {
	async function openUnderHeldWrite(runtime: "bun" | "node", module: string) {
		seedTracker();
		const holder = createDatabaseSync(dbPath);
		// EXCLUSIVE: under a rollback journal this excludes readers outright,
		// which is exactly what WAL exists to prevent.
		holder.exec("BEGIN EXCLUSIVE");
		holder
			.prepare(
				"INSERT OR REPLACE INTO metadata (key, value) VALUES ('pending', 'uncommitted')",
			)
			.run();
		try {
			return await runChild(runtime, module, "open");
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
	}

	function expectOpenedUnderContention(run: ChildRun): void {
		// No SQLITE_BUSY, no TrackerContendedError — it opened.
		expect(run.result.error).toBeNull();
		expect(run.result.constructed).toBe(true);
		expect(run.exitCode).toBe(0);
		expect(run.result.journalMode).toBe("wal");
		// It read the COMMITTED state, not the holder's pending write.
		expect(run.result.seed).toBe("committed");
		expect(run.result.pending).toBeNull();
		// Bounded block, measured from outside the child.
		expect(run.beats).toBeGreaterThanOrEqual(5);
		expect(run.maxBeatGapMs).toBeLessThan(B_MAX_MS);
		// Independent connection: the file is WAL and the holder's row is gone.
		expect(inspect("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
		expect(inspect("SELECT key FROM metadata ORDER BY key")).toEqual([
			{ key: "seed" },
		]);
	}

	test(
		"bun:sqlite — no SQLITE_BUSY, bounded block",
		async () => {
			const run = await openUnderHeldWrite("bun", TRACKER_MODULE);
			expect(run.result.runtime.bun).not.toBeNull();
			expectOpenedUnderContention(run);
			expect(run.result.restingBusyTimeout).toBe(0);
		},
		CHILD_TEST_TIMEOUT_MS,
	);

	test.skipIf(!nodeAvailable())(
		"better-sqlite3 (Node) — the same, and the connection rests at 0, not the driver's 5000 ms default",
		async () => {
			const run = await openUnderHeldWrite("node", buildNodeBundle());
			// It really was the other driver.
			expect(run.result.runtime.bun).toBeNull();
			expectOpenedUnderContention(run);
			// better-sqlite3 opens every connection at `timeout: 5000`
			// (lib/database.js) and sqlite.ts never overrides it. Only the
			// tracker's regions bring it to rest at 0.
			expect(run.result.restingBusyTimeout).toBe(0);
		},
		CHILD_TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// V2.11
// ════════════════════════════════════════════════════════════════════════════

describe("V2.11 — contention past the bounded wait is a NAMED error, never a fallback", () => {
	test(
		"R0: a first open that must CREATE the schema while another process writes fails the OPEN — nothing half-created",
		async () => {
			// A WAL store that exists but has no tracker tables yet — a fresh
			// shared store another worktree is already writing to.
			mkdirSync(dirname(dbPath), { recursive: true });
			const setup = createDatabaseSync(dbPath);
			setup.prepare("PRAGMA journal_mode = WAL").get();
			setup.exec("CREATE TABLE holder_probe (x INTEGER)");
			setup.close();

			const holder = createDatabaseSync(dbPath);
			holder.exec("BEGIN IMMEDIATE");
			holder.prepare("INSERT INTO holder_probe VALUES (1)").run();
			let run: ChildRun;
			try {
				run = await runChild("bun", TRACKER_MODULE, "open");
			} finally {
				holder.exec("ROLLBACK");
				holder.close();
			}

			expect(run.exitCode).toBe(3);
			expect(run.result.constructed).toBe(false);
			expect(run.result.error?.name).toBe("TrackerContendedError");
			expect(run.result.error?.region).toBe("R0");
			expect(run.maxBeatGapMs).toBeLessThan(B_MAX_MS);
			// No tracker table exists: the open refused rather than half-building.
			expect(
				inspect("SELECT name FROM sqlite_master WHERE type = 'table'"),
			).toEqual([{ name: "holder_probe" }]);
		},
		CHILD_TEST_TIMEOUT_MS,
	);

	test(
		"writes: every contended write is a TrackerContendedError, none is skipped, and a spent budget stops the waiting",
		async () => {
			seedTracker();
			const holder = createDatabaseSync(dbPath);
			holder.exec("BEGIN IMMEDIATE");
			holder
				.prepare(
					"INSERT OR REPLACE INTO metadata (key, value) VALUES ('holder', 'x')",
				)
				.run();
			let run: ChildRun;
			try {
				run = await runChild("bun", TRACKER_MODULE, "writes-after-go");
			} finally {
				holder.exec("ROLLBACK");
				holder.close();
			}

			expect(run.exitCode).toBe(3);
			const attempts = run.result.attempts ?? [];
			expect(attempts).toHaveLength(8);
			for (const attempt of attempts) {
				expect(attempt.ok).toBe(false);
				expect(attempt.error?.name).toBe("TrackerContendedError");
				expect(attempt.error?.region).toBe("R-write");
			}

			// While budget remained, the clamp let a write wait; once the
			// per-process budget was spent, the waiting stopped. The boundary is
			// half an allowance: a waited attempt is ~250 ms, an unwaited one ~0.
			const waited = attempts.filter((a) => a.ms >= BUSY_TIMEOUT_MS / 2);
			expect(waited.length).toBeGreaterThanOrEqual(1);
			expect(waited.length).toBeLessThanOrEqual(
				Math.ceil(TRACKER_CONTENTION_BUDGET_MS / BUSY_TIMEOUT_MS),
			);
			expect(attempts.at(-1)?.ms).toBeLessThan(BUSY_TIMEOUT_MS / 2);
			expect(run.maxBeatGapMs).toBeLessThan(B_MAX_MS);

			// Nothing the child attempted landed, and the seed is intact.
			expect(inspect("SELECT key FROM metadata ORDER BY key")).toEqual([
				{ key: "seed" },
			]);
		},
		CHILD_TEST_TIMEOUT_MS,
	);

	test(
		"reads: under the rollback fallback a contended read retries once, then fails NON-ZERO with no rows — never an empty result",
		async () => {
			// Seeded by a CHILD, whose exit really closes its connection. A tracker
			// closed in THIS process lingers as a zombie (bun defers the close
			// while statements await GC) holding the WAL's shared memory, and the
			// switch back to a rollback journal below needs exclusive access.
			const seeded = await runChild("bun", TRACKER_MODULE, "seed", undefined, [
				"src/a.ts",
				"src/b.ts",
			]);
			expect(seeded.result.error).toBeNull();
			// Back to a rollback journal. A reader holding SHARED while the child
			// opens is what denies the switch into WAL (measured: SQLITE_BUSY), so
			// the child stays in rollback mode — §3.5.3 item 5's fallback, where
			// readers DO contend with a writer.
			const reset = createDatabaseSync(dbPath);
			reset.prepare("PRAGMA journal_mode = DELETE").get();
			reset.close();

			const holder = createDatabaseSync(dbPath);
			holder.exec("BEGIN");
			holder.prepare("SELECT count(*) AS n FROM files").get(); // SHARED
			let run: ChildRun;
			try {
				run = await runChild("bun", TRACKER_MODULE, "read-after-go", () => {
					// The child is open. Now become a writer that excludes readers.
					holder.exec("COMMIT");
					holder.exec("BEGIN EXCLUSIVE");
					holder
						.prepare(
							"INSERT OR REPLACE INTO metadata (key, value) VALUES ('holder', 'x')",
						)
						.run();
				});
			} finally {
				try {
					holder.exec("ROLLBACK");
				} catch {
					// Already ended.
				}
				holder.close();
			}

			// WAL did not stick, and the open STILL succeeded — the fallback.
			expect(run.stdout).toMatch(/^READY delete$/m);
			// The read failed loudly: non-zero, named, and not one row printed.
			expect(run.exitCode).toBe(3);
			expect(run.stdout).not.toMatch(/^ROW /m);
			expect(run.result.rows).toBeNull();
			expect(run.result.error?.name).toBe("TrackerContendedError");
			expect(run.result.error?.region).toBe("R-read");
			// Two attempts at 125 ms each: one region's worth, not more.
			expect(run.maxBeatGapMs).toBeLessThan(B_MAX_MS);

			// Positive control: the rows were there all along.
			expect(inspect("SELECT path FROM files ORDER BY path")).toEqual([
				{ path: "src/a.ts" },
				{ path: "src/b.ts" },
			]);
		},
		CHILD_TEST_TIMEOUT_MS,
	);
});
