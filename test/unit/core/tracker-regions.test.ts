/**
 * The tracker's regions — V2.9, V2.10, and the arithmetic's inputs, OBSERVED.
 *
 * `src/core/tracker.ts` extends CLAUDE.md #31's blocking bound to the file
 * tracker: every statement runs inside `withRegion(region, fn)`, which sets
 * `busy_timeout` to the region's allowance DIVIDED by its blocking statements
 * before the first statement and back to 0 after the last. Four kinds of
 * evidence live here, none of them a self-report by the class:
 *
 *   1. V2.10 — static sweeps over the SOURCE (SR-1, SR-1b-d, SR-2, N32), with
 *      fixtures proving each rule can fire;
 *   2. V2.9  — `src/core/sqlite.ts`, the shared opener, sets no pragma: the
 *      embed cache must set `auto_vacuum` BEFORE WAL while its header is empty;
 *   3. the clamp values each region runs at, as literals (not the formula
 *      re-typed);
 *   4. the driver seam — `sqlite.ts` module-mocked with a recording
 *      pass-through (the device `tracker-schema-memo.test.ts` uses) — so R0's
 *      declared count is pinned against the statements it really issues, and
 *      every statement a full exercise of the API issues is shown to have
 *      executed under a region's clamp rather than at rest.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Parser } from "web-tree-sitter";
import type { SymbolDefinition, SymbolReference } from "../../../src/types.js";
import {
	type RegionRule,
	regionCensus,
	sweepRegionSource,
	typescriptParser,
} from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const TRACKER_SOURCE = join(REPO, "src", "core", "tracker.ts");
const SQLITE_SOURCE = join(REPO, "src", "core", "sqlite.ts");

// ── The driver seam ─────────────────────────────────────────────────────────
// The real opener is captured BY VALUE before the mock is registered, so the
// recording wrapper delegates to it instead of recursing into itself.
const realCreateDatabaseSync = (await import("../../../src/core/sqlite.js"))
	.createDatabaseSync;

interface Issued {
	sql: string;
	kind: "exec" | "run" | "get" | "all";
	/** The busy_timeout THIS connection was at when the statement executed. */
	busyTimeout: number;
}

let issued: Issued[] = [];

const BUSY_PRAGMA = /^PRAGMA busy_timeout = (\d+)$/;

mock.module("../../../src/core/sqlite.js", () => ({
	createDatabaseSync: (path: string) => {
		const db = realCreateDatabaseSync(path);
		// bun:sqlite's default. The tracker's first act is to set it explicitly,
		// so the starting value never reaches an assertion below.
		let busyTimeout = 0;
		const record = (sql: string, kind: Issued["kind"]) => {
			issued.push({ sql, kind, busyTimeout });
		};
		return {
			...db,
			exec: (sql: string) => {
				const match = BUSY_PRAGMA.exec(sql.trim());
				if (match) busyTimeout = Number(match[1]);
				record(sql, "exec");
				return db.exec(sql);
			},
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					run: (...params: unknown[]) => {
						record(sql, "run");
						return stmt.run(...params);
					},
					get: (...params: unknown[]) => {
						record(sql, "get");
						return stmt.get(...params);
					},
					all: (...params: unknown[]) => {
						record(sql, "all");
						return stmt.all(...params);
					},
				};
			},
		};
	},
}));

// Imported AFTER the mock so the tracker picks up the recording opener.
const {
	FileTracker,
	resetTrackerContentionBudget,
	resetTrackerSchemaCache,
	TRACKER_CONTENTION_BUDGET_MS,
	TRACKER_REGIONS,
	trackerBusyTimeoutMs,
} = await import("../../../src/core/tracker.js");
const { BUSY_TIMEOUT_MS } = await import("../../../src/core/sync-region.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

let parser: Parser;
const tempDirs: string[] = [];

beforeAll(async () => {
	parser = await typescriptParser();
});

beforeEach(() => {
	issued = [];
	resetTrackerSchemaCache();
	resetTrackerContentionBudget();
});

afterEach(() => {
	resetTrackerSchemaCache();
	resetTrackerContentionBudget();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tracker-regions-"));
	tempDirs.push(dir);
	return dir;
}

function rulesOf(source: string): RegionRule[] {
	return sweepRegionSource(source, parser).map((f) => f.rule);
}

/**
 * Individual SQL statements in one `exec` string: `--` comments stripped (the
 * core DDL has a `;` inside one), then split on `;`. Test-side and independent
 * of the tracker's own count, which is the point.
 */
function statementsIn(sql: string): number {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.filter((part) => part.trim().length > 0).length;
}

function isClampPragma(entry: Issued): boolean {
	return entry.kind === "exec" && BUSY_PRAGMA.test(entry.sql.trim());
}

/** A database as an older mnemex left it — every migration has work to do. */
function makeOldSchemaDatabase(dbPath: string): void {
	const db = realCreateDatabaseSync(dbPath);
	try {
		db.exec(`
			CREATE TABLE files (
				path TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL,
				mtime REAL NOT NULL,
				chunk_ids TEXT NOT NULL,
				indexed_at TEXT NOT NULL
			);
			CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				document_type TEXT NOT NULL,
				file_path TEXT,
				source_ids TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL,
				enriched_at TEXT
			);
		`);
	} finally {
		db.close();
	}
}

// ════════════════════════════════════════════════════════════════════════════
// V2.10 — the sweeps
// ════════════════════════════════════════════════════════════════════════════

describe("V2.10 — the region sweeps over src/core/tracker.ts", () => {
	test("SR-1, SR-1b, SR-1c, SR-1d, SR-2 and N32 find nothing", () => {
		const findings = sweepRegionSource(
			readFileSync(TRACKER_SOURCE, "utf8"),
			parser,
		);
		expect(findings).toEqual([]);
	});

	test("the sweep is not vacuous: it saw the tracker's regions and statements", () => {
		const census = regionCensus(readFileSync(TRACKER_SOURCE, "utf8"), parser);
		// One region per public method plus R0 and getChanges' second — well
		// over sixty — and more statements than regions.
		expect(census.regions).toBeGreaterThanOrEqual(60);
		expect(census.statements).toBeGreaterThan(census.regions);
	});
});

describe("the sweep rules fire on the shapes they exist for", () => {
	const MACHINERY = `
		private withRegion<T>(region: unknown, fn: () => T): T {
			this.db.exec("PRAGMA busy_timeout = 1");
			try { return fn(); } finally { this.db.exec("PRAGMA busy_timeout = 0"); }
		}`;

	const cls = (body: string) => `class T {${MACHINERY}\n${body}\n}`;

	test("a clean class — statements in regions, a yield per loop turn — passes", () => {
		expect(
			rulesOf(
				cls(`
			read() { return this.withRegion(R, () => this.db.prepare("SELECT 1").get()); }
			write() { this.withRegion(W, () => { const s = this.db.prepare("I"); s.run(1); }); }
			async drive(items: string[]) {
				for (const item of items) {
					this.withRegion(W, () => this.db.prepare("X").run(item));
					await yieldToEventLoop();
				}
			}`),
			),
		).toEqual([]);
	});

	test("SR-1: a statement outside any region", () => {
		expect(
			rulesOf(cls(`get() { return this.db.prepare("SELECT 1").get(); }`)),
		).toEqual(["SR-1"]);
		expect(rulesOf(cls(`wipe() { this.db.exec("DELETE FROM t"); }`))).toEqual([
			"SR-1",
		]);
	});

	test("SR-1 is comment- and string-blind: SQL text is not a call", () => {
		expect(
			rulesOf(
				cls(`
			// this.db.prepare("SELECT 1").get();
			/* this.db.exec("DELETE FROM t"); */
			note() { return "this.db.prepare(x) and this.db.exec(y)"; }`),
			),
		).toEqual([]);
	});

	test("SR-1b: a statement prepared inside a region and executed outside it", () => {
		expect(
			rulesOf(
				cls(`
			leak() {
				let s;
				this.withRegion(R, () => { s = this.db.prepare("SELECT 1"); });
				return s.get();
			}`),
			),
		).toEqual(["SR-1b"]);
	});

	test("SR-1c: an async region callback", () => {
		expect(
			rulesOf(
				cls(`
			async bad() {
				this.withRegion(R, async () => { await tick(); this.db.prepare("S").run(); });
			}`),
			),
		).toEqual(["SR-1c"]);
	});

	test("SR-1d: a region opened inside a region", () => {
		expect(
			rulesOf(
				cls(`
			nested() {
				this.withRegion(R, () => this.withRegion(W, () => this.db.prepare("S").run()));
			}`),
			),
		).toEqual(["SR-1d"]);
	});

	test("SR-2: a region in a loop with no await at all", () => {
		expect(
			rulesOf(
				cls(`
			all(xs: string[]) {
				for (const x of xs) this.withRegion(W, () => this.db.prepare("S").run(x));
			}`),
			),
		).toEqual(["SR-2"]);
		expect(
			rulesOf(
				cls(`
			drain() {
				while (this.more()) { this.withRegion(W, () => this.db.prepare("S").run()); }
			}`),
			),
		).toEqual(["SR-2"]);
	});

	test("SR-2: two regions per turn with the await only between them — the wrap-around is unyielded", () => {
		expect(
			rulesOf(
				cls(`
			async twice(xs: string[]) {
				for (const x of xs) {
					this.withRegion(A, () => this.db.prepare("S").run(x));
					await yieldToEventLoop();
					this.withRegion(B, () => this.db.prepare("T").run(x));
				}
			}`),
			),
		).toEqual(["SR-2"]);
	});

	test("SR-2: an await before each region satisfies it, wrap-around included", () => {
		expect(
			rulesOf(
				cls(`
			async twice(xs: string[]) {
				for (const x of xs) {
					await yieldToEventLoop();
					this.withRegion(A, () => this.db.prepare("S").run(x));
					await yieldToEventLoop();
					this.withRegion(B, () => this.db.prepare("T").run(x));
				}
			}`),
			),
		).toEqual([]);
	});

	test("SR-2: an await inside a nested function does not yield the loop", () => {
		expect(
			rulesOf(
				cls(`
			async sneaky(xs: string[]) {
				for (const x of xs) {
					this.withRegion(A, () => this.db.prepare("S").run(x));
					const later = async () => { await yieldToEventLoop(); };
				}
			}`),
			),
		).toEqual(["SR-2"]);
	});

	test("SR-2: a region inside an array iterator's callback", () => {
		expect(
			rulesOf(
				cls(`
			each(xs: string[]) {
				xs.forEach((x) => this.withRegion(W, () => this.db.prepare("S").run(x)));
			}`),
			),
		).toEqual(["SR-2"]);
	});

	test("N32: db.transaction() anywhere", () => {
		expect(
			rulesOf(
				cls(`
			batch() {
				this.withRegion(W, () => { this.db.transaction(() => {}); });
			}`),
			),
		).toEqual(["N32"]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// V2.9 — the shared opener sets no pragma
// ════════════════════════════════════════════════════════════════════════════

describe("V2.9 — src/core/sqlite.ts sets no pragma", () => {
	test("contains no PRAGMA string, in any case, comments included", () => {
		// The raw file, deliberately: this module is the shared opener for the
		// embed cache, whose `auto_vacuum` must precede WAL while the header is
		// empty (CLAUDE.md #31). A pragma here — even one described in a comment
		// that someone later uncomments — silently reverses that order. The
		// reasoning lives in tracker.ts and embed-cache.ts, not here.
		const source = readFileSync(SQLITE_SOURCE, "utf8");
		expect(source.match(/pragma/gi)).toBeNull();
	});

	test("passes no driver timeout option either (architecture §3.5.3 item 4)", () => {
		const source = readFileSync(SQLITE_SOURCE, "utf8");
		expect(source.match(/timeout/gi)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The clamp each region runs at
// ════════════════════════════════════════════════════════════════════════════

describe("the clamp, as the tracker's regions apply it", () => {
	test("per-statement busy_timeout: the shared clamp, DIVIDED — literal values", () => {
		// R0: 45 statements → floor(250 / 45). It gained `idx_files_path`
		// (I-12 Ruling 2), the four `PRAGMA table_info` probes that decide
		// whether a branch-leading index can be created at all, and the 14
		// branch-leading indexes themselves.
		expect(TRACKER_REGIONS.open.blockingStatements).toBe(45);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.open, 0)).toBe(5);
		// Reads retry once, so 1 statement is 2 chances to wait → floor(250 / 2)
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.changes, 0)).toBe(125);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.read, 0)).toBe(125);
		// A 6-SELECT read (getSymbolGraphStats) → floor(250 / 12)
		expect(
			trackerBusyTimeoutMs(
				{ ...TRACKER_REGIONS.read, blockingStatements: 6 },
				0,
			),
		).toBe(20);
		// One autocommit write → the whole allowance
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.write, 0)).toBe(250);
		// BEGIN IMMEDIATE + COMMIT → floor(250 / 2)
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.txn, 0)).toBe(125);
	});

	test("EVERY region's busy-wait, retry included, fits BUSY_TIMEOUT_MS", () => {
		for (const region of Object.values(TRACKER_REGIONS)) {
			const attempts = region.onContention === "retry-once" ? 2 : 1;
			const wait =
				region.blockingStatements * attempts * trackerBusyTimeoutMs(region, 0);
			expect(wait).toBeLessThanOrEqual(BUSY_TIMEOUT_MS);
		}
	});

	test("the process budget shrinks the allowance before it is divided, and ends waiting at 0", () => {
		expect(TRACKER_CONTENTION_BUDGET_MS).toBe(1000);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.write, 900)).toBe(100);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.txn, 900)).toBe(50);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.write, 1000)).toBe(0);
		expect(trackerBusyTimeoutMs(TRACKER_REGIONS.write, 5000)).toBe(0);
	});

	test("R-txn is the only transactional region, and the only one that claims 2", () => {
		for (const region of Object.values(TRACKER_REGIONS)) {
			expect(region.immediateTransaction).toBe(region.name === "R-txn");
		}
		expect(TRACKER_REGIONS.txn.blockingStatements).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Observed at the driver seam
// ════════════════════════════════════════════════════════════════════════════

describe("observed at the driver seam", () => {
	test("R0's declared count equals the statements it issues on the longest path, plus the contended-WAL read-back", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");
		makeOldSchemaDatabase(dbPath); // every ALTER has work to do
		issued = [];

		const tracker = new FileTracker(dbPath, root);
		tracker.close();

		// R0 is everything between its clamp and the first rest.
		const start = issued.findIndex(
			(e) => e.sql.trim() === "PRAGMA busy_timeout = 5",
		);
		const end = issued.findIndex(
			(e, i) => i > start && e.sql.trim() === "PRAGMA busy_timeout = 0",
		);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);

		const r0 = issued.slice(start + 1, end);
		let statements = 0;
		for (const entry of r0) {
			statements += entry.kind === "exec" ? statementsIn(entry.sql) : 1;
		}
		// Two declared statements this path cannot issue, and both absences are
		// the point:
		//
		//   1. the read-back `PRAGMA journal_mode`, which runs only when the WAL
		//      switch was contended;
		//   2. the TWO branch-leading `documents` indexes. This fixture's
		//      `documents` is at the PRE-v4 shape and has no `branch_id`, so
		//      `openRegion` skips them — which is exactly what keeps a v3
		//      database openable at all (R0 fails the open, and §6.1's upgrade
		//      signal is read from an OPEN tracker). `symbols`,
		//      `symbol_references` and `indexed_docs` do not exist in the fixture,
		//      so `CREATE TABLE IF NOT EXISTS` makes them at the v4 shape and
		//      their 12 indexes DO run.
		const SKIPPED_ON_THIS_FIXTURE = 1 + 2;
		expect(statements + SKIPPED_ON_THIS_FIXTURE).toBe(
			TRACKER_REGIONS.open.blockingStatements,
		);
		// Not vacuous: the open SUCCEEDED over the old shape, and the tracker
		// says so. Before the conditional index pass this threw
		// `no such column: branch_id` and no v3 store could be upgraded.
		const reopened = new FileTracker(dbPath, root);
		expect(reopened.trackerNeedsV4Schema()).toBe(true);
		reopened.close();

		// ONE statement per exec. bun:sqlite's multi-statement exec carries on
		// past a SQLITE_BUSY and loses it (see CORE_SCHEMA_DDL), so a batch here
		// could report success over a half-created schema.
		const batched = r0.filter(
			(e) => e.kind === "exec" && statementsIn(e.sql) !== 1,
		);
		expect(batched.map((e) => e.sql.trim().slice(0, 50))).toEqual([]);
	});

	test("a database removed WITHOUT its WAL sidecars is reset cleanly, even while a closed tracker's connection lingers", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const first = new FileTracker(dbPath, root);
		first.setMetadata("k", "from the deleted database");
		first.close(); // bun defers the real close: this connection lingers

		expect(existsSync(`${dbPath}-wal`)).toBe(true);
		rmSync(dbPath); // `rm .mnemex/index.db` — the sidecars stay behind

		const second = new FileTracker(dbPath, root);
		// A fresh, fully schema'd database: nothing leaked from the dead WAL.
		expect(second.getMetadata("k")).toBeNull();
		second.setMetadata("k", "fresh");
		expect(second.getMetadata("k")).toBe("fresh");
		expect(second.journalMode).toBe("wal");
		second.close();
	});

	test("each region sets its divided clamp first and rests at 0 last", () => {
		const root = makeTempDir();
		const tracker = new FileTracker(join(root, "index.db"), root);

		const clampsFor = (run: () => unknown): string[] => {
			issued = [];
			run();
			return issued.filter(isClampPragma).map((e) => e.sql.trim());
		};

		expect(clampsFor(() => tracker.getMetadata("k"))).toEqual([
			"PRAGMA busy_timeout = 125",
			"PRAGMA busy_timeout = 0",
		]);
		expect(clampsFor(() => tracker.setMetadata("k", "v"))).toEqual([
			"PRAGMA busy_timeout = 250",
			"PRAGMA busy_timeout = 0",
		]);
		expect(clampsFor(() => tracker.clear())).toEqual([
			"PRAGMA busy_timeout = 125",
			"PRAGMA busy_timeout = 0",
		]);
		expect(clampsFor(() => tracker.graph(1).getSymbolGraphStats())).toEqual([
			"PRAGMA busy_timeout = 20",
			"PRAGMA busy_timeout = 0",
		]);
		tracker.close();
	});

	test("every statement a full exercise of the API issues runs under a region's clamp, never at rest", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");
		const real = join(root, "real.ts");
		writeFileSync(real, "export const x = 1;\n");

		const tracker = new FileTracker(dbPath, root);
		const now = new Date().toISOString();
		const symbol = (id: string, name: string): SymbolDefinition =>
			({
				id,
				name,
				kind: "function",
				filePath: "src/a.ts",
				startLine: 1,
				endLine: 2,
				isExported: true,
				language: "typescript",
				pagerankScore: 0,
				createdAt: now,
				updatedAt: now,
			}) as SymbolDefinition;
		const reference = (from: string, to: string): SymbolReference =>
			({
				fromSymbolId: from,
				toSymbolName: to,
				kind: "call",
				filePath: "src/a.ts",
				line: 1,
				isResolved: false,
				createdAt: now,
			}) as SymbolReference;

		// Files and metadata
		tracker.markIndexed(0, join(root, "src/a.ts"), "h1", ["c1"]);
		tracker.markIndexed(0, real, "stale-mtime", ["c2"]);
		expect(tracker.getChunkIds(0, join(root, "src/a.ts"))).toEqual(["c1"]);
		expect(tracker.getFileState(0, join(root, "src/a.ts"))?.chunkIds).toEqual([
			"c1",
		]);
		expect(tracker.getAllFiles(0)).toHaveLength(2);
		tracker.setMetadata("k", "v");
		expect(tracker.getMetadata("k")).toBe("v");
		expect(tracker.getStats(0).totalFiles).toBe(2);

		// getChanges' second region: same content, moved mtime → refreshed.
		const { createHash } =
			require("node:crypto") as typeof import("node:crypto");
		const realHash = createHash("sha256")
			.update(readFileSync(real))
			.digest("hex");
		tracker.markIndexed(0, real, realHash, ["c2"]);
		utimesSync(real, new Date(2001, 0, 1), new Date(2001, 0, 1));
		const changes = tracker.getChanges(0, [real, join(root, "src/new.ts")]);
		expect(changes.unchangedFiles).toEqual([real]);
		expect(changes.newFiles).toEqual([join(root, "src/new.ts")]);
		expect(tracker.getFileState(0, real)?.mtime).toBe(
			new Date(2001, 0, 1).getTime(),
		);

		// Activity
		const id = tracker.recordActivity("search", { q: 1 });
		expect(tracker.getActivity(0, 10).map((r) => r.id)).toContain(id);
		tracker.pruneActivity(10);

		// Enrichment — the read-modify-write keeps the other key.
		tracker.setEnrichmentState(
			0,
			join(root, "src/a.ts"),
			"file_summary",
			"complete",
		);
		tracker.setEnrichmentState(
			0,
			join(root, "src/a.ts"),
			"symbol_summary",
			"pending",
		);
		expect(tracker.getEnrichmentState(0, join(root, "src/a.ts"))).toEqual({
			file_summary: "complete",
			symbol_summary: "pending",
		});
		expect(
			tracker.needsEnrichment(0, join(root, "src/a.ts"), "file_summary"),
		).toBe(false);
		tracker.setAllEnrichmentStates(0, join(root, "src/a.ts"), {});
		tracker.resetEnrichmentState(0, join(root, "src/a.ts"));
		expect(tracker.getFilesNeedingEnrichment(0, "file_summary")).toHaveLength(
			2,
		);

		// Documents and provenance
		tracker.recordCommit("a".repeat(40), 7, null);
		expect(tracker.getCommitOrdinal("a".repeat(40))).toBe(7);
		tracker.setFileIndexedCommit(0, "src/a.ts", "a".repeat(40));
		expect(tracker.getFileIndexedCommit(0, "src/a.ts")).toBe("a".repeat(40));
		const doc = {
			id: "d1",
			documentType: "file_summary" as const,
			filePath: "src/a.ts",
			sourceIds: ["c1"],
			createdAt: now,
		};
		tracker.trackDocument(0, doc);
		tracker.trackDocuments(0, [{ ...doc, id: "d2" }]);
		tracker.trackDocuments(0, []);
		expect(tracker.getDocumentsForFile(0, join(root, "src/a.ts"))).toHaveLength(
			2,
		);
		expect(tracker.getDocumentsByType(0, "file_summary")).toHaveLength(2);
		expect(tracker.getDocumentCounts(0).file_summary).toBe(2);
		tracker.setDocumentsValidFromCommit(0, ["d1"], "a".repeat(40));
		expect(tracker.getDocumentProvenance(0, "d1")?.validFromCommit).toBe(
			"a".repeat(40),
		);
		expect(
			tracker.markDocumentsStale(
				0,
				["src/a.ts"],
				["file_summary"],
				"b".repeat(40),
			),
		).toBe(2);
		expect(tracker.getStaleDocuments(0, 10)).toHaveLength(2);
		expect(tracker.clearDocumentsStale(0, ["d1", "d2"])).toBe(2);
		expect(
			tracker.countDocumentsForPaths(0, ["src/a.ts"], ["file_summary"]),
		).toBe(2);
		expect(tracker.countDocumentsForPaths(0, [""], ["file_summary"])).toBe(0);
		expect(
			tracker.markDocumentsInvalidated(
				0,
				["src/a.ts"],
				["file_summary"],
				"c".repeat(40),
			),
		).toBe(2);
		expect(tracker.getDocumentStatusCounts(0)[0]?.invalidated).toBe(2);
		expect(tracker.queueReEnrichment(0, ["src/a.ts"], ["file_summary"])).toBe(
			1,
		);
		tracker.deleteDocumentsForFile(0, join(root, "src/a.ts"));
		tracker.deleteDocumentsByType(0, "file_summary");

		// Indexed docs
		tracker.markDocsIndexed("react", "18", "context7", "h", ["x", "y"]);
		expect(tracker.getDocsState("react", "18")?.chunkIds).toEqual(["x", "y"]);
		expect(tracker.needsDocsRefresh("react", "18")).toBe(false);
		expect(tracker.getAllIndexedDocs()).toHaveLength(1);
		expect(tracker.getDocsChunkIds("react", "18")).toEqual(["x", "y"]);
		expect(tracker.getIndexedDocsStats().totalChunks).toBe(2);
		tracker.deleteIndexedDocs("react", "18");
		tracker.deleteIndexedDocs("react");
		tracker.clearAllIndexedDocs();

		// Symbol graph, through the branch-scoped handle — the only way in.
		const graph = tracker.graph(1);
		graph.insertSymbol(symbol("s1", "alpha"));
		graph.insertSymbols([symbol("s2", "beta"), symbol("s3", "gamma")]);
		expect(graph.getSymbol("s1")?.name).toBe("alpha");
		expect(graph.getSymbolsByFile("src/a.ts")).toHaveLength(3);
		expect(graph.getSymbolByName("beta")).toHaveLength(1);
		expect(graph.getSymbolByName("beta", "function")).toHaveLength(1);
		expect(graph.getSymbolsByParent("none")).toHaveLength(0);
		expect(graph.getAllSymbols()).toHaveLength(3);
		expect(graph.getTopSymbols(2)).toHaveLength(2);
		graph.insertReference(reference("s1", "beta"));
		graph.insertReferences([reference("s2", "gamma")]);
		expect(graph.getUnresolvedReferences()).toHaveLength(2);
		expect(graph.resolveReferencesByName()).toBe(2);
		const [firstRef] = graph.getReferencesFrom("s1");
		graph.resolveReference(firstRef?.id as number, "s2");
		expect(graph.getReferencesTo("s2")).toHaveLength(1);
		expect(graph.getAllReferences()).toHaveLength(2);
		graph.updateDegreeCounts();
		graph.updatePageRankScores(new Map([["s1", 0.5]]));
		graph.setGraphMetadata("g", "1");
		expect(graph.getGraphMetadata("g")).toBe("1");
		const stats = graph.getSymbolGraphStats();
		expect(stats.totalSymbols).toBe(3);
		expect(stats.resolvedReferences).toBe(2);
		expect(stats.pagerankComputedAt).toBeTruthy();
		graph.deleteReferencesByFile("src/a.ts");
		graph.deleteSymbolsByFile("src/a.ts");
		graph.clearSymbolGraph();

		tracker.removeFile(0, "src/a.ts");
		tracker.clear();
		tracker.close();

		// THE ASSERTION. Every statement that is not the clamp itself executed
		// while a region's clamp was in force — i.e. INSIDE a region.
		const statements = issued.filter((e) => !isClampPragma(e));
		expect(statements.length).toBeGreaterThan(80);
		const atRest = statements.filter((e) => e.busyTimeout === 0);
		expect(
			atRest.map((e) => `${e.kind}: ${e.sql.trim().slice(0, 60)}`),
		).toEqual([]);
		// ...and the connection was left at rest.
		const clamps = issued.filter(isClampPragma);
		expect(clamps.at(-1)?.sql.trim()).toBe("PRAGMA busy_timeout = 0");
	});

	test("R-txn issues BEGIN IMMEDIATE, and the tracker never issues a deferred BEGIN", () => {
		const root = makeTempDir();
		const tracker = new FileTracker(join(root, "index.db"), root);
		issued = [];
		tracker.clear();
		tracker.close();
		const execs = issued
			.filter((e) => e.kind === "exec")
			.map((e) => e.sql.trim());
		expect(execs).toContain("BEGIN IMMEDIATE");
		expect(execs).toContain("COMMIT");
		expect(execs).not.toContain("BEGIN");
	});

	test("a region opened inside a region is refused before it touches the connection", () => {
		const root = makeTempDir();
		const tracker = new FileTracker(join(root, "index.db"), root);
		const withRegion = (
			tracker as unknown as {
				withRegion: <T>(region: unknown, fn: () => T) => T;
			}
		).withRegion.bind(tracker);
		expect(() =>
			withRegion(TRACKER_REGIONS.write, () => tracker.getMetadata("k")),
		).toThrow(/must not nest/);
		// The outer region still rested the connection, and the tracker works.
		expect(tracker.getMetadata("k")).toBeNull();
		tracker.close();
	});

	test("a failed open closes its connection and caches nothing", () => {
		const root = makeTempDir();
		// A directory where the database file should be: sqlite cannot open it.
		const dbPath = join(root, "index.db");
		require("node:fs").mkdirSync(dbPath);
		expect(() => new FileTracker(dbPath, root)).toThrow();
	});
});
