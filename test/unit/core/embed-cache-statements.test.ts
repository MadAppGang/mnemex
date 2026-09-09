/**
 * What SQL the cache actually issues, counted at the driver seam.
 *
 * `src/core/sqlite.ts` is module-mocked with a counting pass-through — the same
 * device `tracker-schema-memo.test.ts` and `store-fts-index-reuse.test.ts` use —
 * so these are observations of real statements against a real database, not
 * assertions about source text.
 *
 * Four contracts live here, each of which is invisible to behavioural tests:
 *
 *   1. the TWO-LEVEL memo (CLAUDE.md #21): one CONNECTION per file, and one DDL
 *      pass per file+inode — which are different questions, because the level-2
 *      key can only be computed on an ALREADY-OPEN database;
 *   2. ME2: `putMany`'s transaction executes WRITE STATEMENTS ONLY. A deferred
 *      transaction that reads first and writes second returns
 *      SQLITE_BUSY_SNAPSHOT on conflict — the one BUSY kind that does NOT invoke
 *      the busy handler, so the clamp would not bound it;
 *   3. `incremental_vacuum` is NEVER called in its bare form, which on a 2 GiB
 *      file vacuums every free page in one blocking call;
 *   4. THE CLAMP: `busy_timeout` is set at region entry to the region's whole
 *      allowance DIVIDED BY its blocking statements, so the region — not the
 *      statement — is the bounded unit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real opener is captured BY VALUE before the mock is registered, so the
// counting wrapper delegates to it instead of recursing into itself.
const realCreateDatabaseSync = (await import("../../../src/core/sqlite.js"))
	.createDatabaseSync;

interface Recorded {
	path: string;
	sql: string;
	kind: "exec" | "run" | "get" | "all";
	inTxn: boolean;
}

let connections: string[] = [];
let statements: Recorded[] = [];
let txnDepth = 0;

mock.module("../../../src/core/sqlite.js", () => ({
	createDatabaseSync: (path: string) => {
		connections.push(path);
		const db = realCreateDatabaseSync(path);
		const record = (sql: string, kind: Recorded["kind"]) => {
			statements.push({ path, sql, kind, inTxn: txnDepth > 0 });
		};
		return {
			...db,
			exec: (sql: string) => {
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
			transaction: <T>(fn: () => T): T =>
				db.transaction(() => {
					txnDepth++;
					try {
						return fn();
					} finally {
						txnDepth--;
					}
				}),
		};
	},
}));

// Imported AFTER the mock so it picks up the counting opener.
const {
	BUSY_TIMEOUT_MS,
	CONTENTION_BUDGET_MS,
	REGION_LOOKUP,
	REGION_WRITE,
	REGION_EVICT,
	REGION_VACUUM,
	WRITE_CHUNK,
	embedCacheKey,
	openEmbedCache,
	resetEmbedCacheForTests,
} = await import("../../../src/core/embed-cache.js");

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-stmt-"));
	dbPath = join(dir, "embed-cache.db");
	connections = [];
	statements = [];
	txnDepth = 0;
});

afterEach(() => {
	resetEmbedCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

const ddlCount = () =>
	statements.filter((s) => /^\s*CREATE (TABLE|INDEX)/i.test(s.sql)).length;

const busyTimeouts = () =>
	statements
		.filter((s) => /PRAGMA busy_timeout/i.test(s.sql))
		.map((s) => Number(s.sql.split("=")[1]?.trim()));

// ════════════════════════════════════════════════════════════════════════════
describe("the two-level memo (CLAUDE.md #21)", () => {
	test("two opens of one path: ONE connection, ONE DDL pass", () => {
		const a = openEmbedCache(dbPath);
		const ddlAfterFirst = ddlCount();
		expect(ddlAfterFirst).toBe(4); // embeddings, its LRU index, model_dims, meta
		const b = openEmbedCache(dbPath);
		expect(b).toBe(a);
		expect(connections.filter((p) => p === dbPath)).toHaveLength(1);
		expect(ddlCount()).toBe(ddlAfterFirst);
	});

	test("a NEW connection to the same file still skips the DDL — level 2", () => {
		// This is the case the instance memo alone cannot cover, and the reason
		// there are two levels: `close()` drops the instance, so the next open
		// really does construct a second connection. The DDL memo is keyed on the
		// sqlite file+inode, which can only be read from an OPEN database.
		openEmbedCache(dbPath)?.close();
		const ddlAfterFirst = ddlCount();
		openEmbedCache(dbPath);
		expect(connections.filter((p) => p === dbPath)).toHaveLength(2);
		expect(ddlCount()).toBe(ddlAfterFirst);
	});

	test("two in-memory databases: two connections AND two DDL passes", () => {
		// `PRAGMA database_list` reports "" for them, so they are never memoised
		// at either level. Each is a distinct, private, empty database that
		// genuinely needs its own schema; memoising would hand the second one an
		// "already done" verdict and an unschema'd database.
		const a = openEmbedCache(":memory:");
		const b = openEmbedCache(":memory:");
		expect(a).not.toBe(b);
		expect(connections.filter((p) => p === ":memory:")).toHaveLength(2);
		expect(ddlCount()).toBe(8);
		a?.close();
		b?.close();
	});

	test("a different file gets its own DDL pass", () => {
		openEmbedCache(dbPath);
		const other = join(dir, "other.db");
		openEmbedCache(other);
		expect(ddlCount()).toBe(8);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("ME2 — putMany executes WRITE STATEMENTS ONLY", () => {
	test("no SELECT runs inside the transaction, and the FIRST statement is a write", () => {
		const cache = openEmbedCache(dbPath);
		expect(cache).not.toBeNull();
		const key = embedCacheKey("m", 3, "t");
		statements = [];
		cache?.putMany(
			[
				{
					key,
					model: "m",
					provider: "ollama",
					dimension: 3,
					fingerprint: "",
					vector: [1, 2, 3],
				},
			],
			[{ key: "other", provider: "ollama" }],
			{ model: "m", provider: "ollama", dimension: 3 },
		);
		const inTxn = statements.filter((s) => s.inTxn);
		expect(inTxn.length).toBeGreaterThan(0);
		for (const s of inTxn) {
			expect(s.sql).toMatch(/^\s*(INSERT|UPDATE|DELETE)/i);
		}
		expect(inTxn[0]?.sql).toMatch(/^INSERT OR REPLACE INTO embeddings/i);
	});

	test("a touch-only putMany still opens with a write", () => {
		// The all-hits path: no entries, only `touched`. The first statement must
		// still take the write lock, or the transaction is a reader that upgrades.
		const cache = openEmbedCache(dbPath);
		statements = [];
		cache?.putMany([], [{ key: "k", provider: "ollama" }]);
		const inTxn = statements.filter((s) => s.inTxn);
		expect(inTxn).not.toHaveLength(0);
		expect(inTxn[0]?.sql).toMatch(/^UPDATE embeddings/i);
	});

	test("a putMany with nothing to do issues NO statements at all", () => {
		const cache = openEmbedCache(dbPath);
		statements = [];
		cache?.putMany([], []);
		expect(statements).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("incremental_vacuum is never called in its bare form", () => {
	test("every vacuum carries an explicit page count", async () => {
		const cache = openEmbedCache(dbPath, { maxBytes: 256 * 1024 });
		expect(cache).not.toBeNull();
		const vec = Array.from({ length: 64 }, (_, i) => i);
		for (let i = 0; i < 2000; i += WRITE_CHUNK) {
			const slice = [];
			for (let j = i; j < Math.min(i + WRITE_CHUNK, 2000); j++) {
				slice.push({
					key: embedCacheKey("m", 64, `t${j}`),
					model: "m",
					provider: "ollama",
					dimension: 64,
					fingerprint: "",
					vector: vec,
				});
			}
			cache?.putMany(slice, []);
		}
		statements = [];
		const report = await (cache as NonNullable<typeof cache>).enforceBudget();
		expect(report.vacuumCalls).toBeGreaterThan(0);

		const vacuums = statements.filter((s) => /incremental_vacuum/i.test(s.sql));
		expect(vacuums.length).toBe(report.vacuumCalls);
		for (const v of vacuums) {
			expect(v.sql).toMatch(/incremental_vacuum\(\d+\)/);
			// The bare form — `PRAGMA incremental_vacuum` with no argument — would
			// vacuum every free page of a 2 GiB file in one blocking call.
			expect(v.sql).not.toMatch(/incremental_vacuum\s*(;|$)/);
		}
	});

	test("every SELECT that can return many rows carries a LIMIT", async () => {
		const cache = openEmbedCache(dbPath, { maxBytes: 4096 });
		cache?.putMany(
			[
				{
					key: embedCacheKey("m", 2, "t"),
					model: "m",
					provider: "ollama",
					dimension: 2,
					fingerprint: "",
					vector: [1, 2],
				},
			],
			[],
		);
		statements = [];
		await (cache as NonNullable<typeof cache>).enforceBudget();
		for (const s of statements) {
			if (!/^\s*SELECT/i.test(s.sql)) continue;
			// Either a point lookup on a primary key, or an explicitly LIMITed scan.
			const bounded = /LIMIT\s+\?/i.test(s.sql) || /WHERE/i.test(s.sql);
			expect(bounded).toBe(true);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("THE CLAMP — the region is the bounded unit, not the statement", () => {
	test("the resting value at open is BUSY_TIMEOUT_MS, not 2000", () => {
		openEmbedCache(dbPath);
		expect(busyTimeouts()).toEqual([BUSY_TIMEOUT_MS]);
	});

	test("each region's allowance is DIVIDED BY its blocking statements", () => {
		// This is the fix for the r3 review's HIGH finding (both reviewers, found
		// independently): a once-per-region clamp of `min(250, remaining)` cannot
		// bound a region that holds 64 statements — 64 x 250 ms is 16 s. Dividing
		// the region's allowance across its statements makes
		//     region busy-wait <= blockingStatements x perStatement <= 250 ms
		// hold for EVERY region, independently of the process budget and of how
		// the contention is distributed inside the region.
		const cache = openEmbedCache(dbPath);
		expect(cache).not.toBeNull();
		const key = embedCacheKey("m", 3, "t");

		statements = [];
		cache?.get(key, "ollama", 3, "");
		expect(busyTimeouts()).toEqual([Math.floor(BUSY_TIMEOUT_MS / 64)]);

		statements = [];
		cache?.putMany(
			[
				{
					key,
					model: "m",
					provider: "ollama",
					dimension: 3,
					fingerprint: "",
					vector: [1, 2, 3],
				},
			],
			[],
		);
		expect(busyTimeouts()).toEqual([Math.floor(BUSY_TIMEOUT_MS / 3)]);
	});

	test("the pragma is re-issued only when the value CHANGES", () => {
		// The budget is process-wide, so re-reading it inside a region cannot make
		// the region shorter; issuing the pragma per statement would only double
		// the statement count on the hottest path.
		const cache = openEmbedCache(dbPath);
		const key = embedCacheKey("m", 3, "t");
		cache?.get(key, "ollama", 3, "");
		statements = [];
		for (let i = 0; i < 64; i++) cache?.get(key, "ollama", 3, "");
		expect(busyTimeouts()).toEqual([]);
	});

	test("the bound holds arithmetically for every declared region", () => {
		for (const region of [
			REGION_LOOKUP,
			REGION_WRITE,
			REGION_EVICT,
			REGION_VACUUM,
		]) {
			const perStatement = Math.floor(
				BUSY_TIMEOUT_MS / region.blockingStatements,
			);
			expect(perStatement * region.blockingStatements).toBeLessThanOrEqual(
				BUSY_TIMEOUT_MS,
			);
			// …and the whole process cannot spend more than its budget waiting,
			// which is what makes the SECOND mechanism independent of the first.
			expect(BUSY_TIMEOUT_MS).toBeLessThanOrEqual(CONTENTION_BUDGET_MS);
		}
	});
});
