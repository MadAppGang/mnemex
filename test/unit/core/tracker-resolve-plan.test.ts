/**
 * `resolveReferencesByName()` — the query PLAN, and the result set, pinned.
 *
 * THE DEFECT (Finding C, `implementation-log-indexer-regions.md`). The statement
 * is ONE `UPDATE` with two correlated subqueries, each filtering
 * `s.name = symbol_references.to_symbol_name AND s.is_exported = 1`. A tracker
 * database carries no `ANALYZE` statistics, and without them SQLite answers the
 * `is_exported = 1` term from the PARTIAL index `idx_symbols_exported` (present
 * since v0.3.0), which holds every exported symbol. So each unresolved reference
 * walked every exported symbol, twice, inside one synchronous statement — a
 * cost of unresolved-references x exported-symbols that no caller-side yield
 * can split. Measured: 5 400 ms at 8 000 exported x 20 000 references; 590 s of
 * frozen heartbeat at 88 000 exported.
 *
 * THE FIX is `+s.is_exported = 1`. The unary plus makes the left side an
 * expression rather than a column reference, so neither the partial index's
 * WHERE clause nor a plain index on `is_exported` can match it, and the planner
 * takes `idx_symbols_name (name=?)` — an equality on the reference's own name.
 *
 * WHY THE GUARD IS A PLAN AND NOT A STOPWATCH. Timing tests on this machine
 * flaked at load average 68. `EXPLAIN QUERY PLAN` is deterministic and
 * independent of load, and it names the access path, which IS the defect. The
 * SQL explained is the SQL the tracker actually prepared (captured at the
 * connection), not a copy of it.
 *
 * WHY THE RESULT SET IS IDENTICAL, by reading the code — the fix must change
 * which index is used and nothing else:
 *   1. `+x` is SQLite's no-op operator: same value as `x`. It drops the
 *      column's affinity, but here the other operand is the literal `1` and
 *      affinity is only ever applied to the literal side: `1` under NUMERIC
 *      affinity is still the integer 1. Stored values are unchanged either
 *      way, and `is_exported` is only ever written as `isExported ? 1 : 0`
 *      (or its DEFAULT 0). NULL compares as NULL under both spellings.
 *   2. `LIMIT 1` with no ORDER BY returns the first row the plan visits. Both
 *      indexes are single-column over a rowid table, so an index entry is
 *      (key, rowid). The OLD plan walks `idx_symbols_exported` over
 *      is_exported = 1 — rowid order — testing the name; the NEW plan walks
 *      `idx_symbols_name` over name = X — rowid order — testing is_exported.
 *      Either way the first hit is the exported symbol with that name and the
 *      LOWEST rowid. Same row.
 *   3. `EXISTS` is a boolean over the same predicate: plan-independent.
 * The tests below check 2 empirically on a fixture where rowid order differs
 * from insertion-by-id order (an `INSERT OR REPLACE` moves a row to a new
 * rowid), against the pre-fix statement text AND an independent JS oracle.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTracker } from "../../../src/core/tracker.js";
import type { SymbolDefinition, SymbolReference } from "../../../src/types.js";

/**
 * The statement exactly as it stood before the fix — the ORACLE for "the fix
 * changes no result". Kept verbatim so the comparison is against the real
 * pre-fix behaviour, not a paraphrase of it.
 */
const PRE_FIX_SQL = `
			UPDATE symbol_references
			SET to_symbol_id = (
				SELECT s.id FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND s.is_exported = 1
				LIMIT 1
			),
			is_resolved = 1
			WHERE is_resolved = 0
			AND EXISTS (
				SELECT 1 FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND s.is_exported = 1
			)
		`;

const NAME_INDEX_SEARCH = "SEARCH s USING INDEX idx_symbols_name (name=?)";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function openTracker(): FileTracker {
	const root = mkdtempSync(join(tmpdir(), "tracker-resolve-plan-"));
	tempDirs.push(root);
	return new FileTracker(join(root, "index.db"), root);
}

const NOW = "2026-01-01T00:00:00.000Z";

function symbol(
	id: string,
	name: string,
	isExported: boolean,
): SymbolDefinition {
	return {
		id,
		name,
		kind: "function",
		filePath: `src/${id}.ts`,
		startLine: 1,
		endLine: 2,
		isExported,
		language: "typescript",
		pagerankScore: 0,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function reference(
	from: string,
	toName: string,
	resolvedTo?: string,
): SymbolReference {
	return {
		fromSymbolId: from,
		toSymbolName: toName,
		toSymbolId: resolvedTo,
		kind: "call",
		filePath: "src/caller.ts",
		line: 1,
		isResolved: resolvedTo !== undefined,
		createdAt: NOW,
	};
}

interface RefRow {
	id: number;
	to_symbol_name: string;
	to_symbol_id: string | null;
	is_resolved: number;
}

function refRows(tracker: FileTracker): RefRow[] {
	return tracker
		.getDatabase()
		.prepare(
			"SELECT id, to_symbol_name, to_symbol_id, is_resolved FROM symbol_references ORDER BY id",
		)
		.all() as RefRow[];
}

/** Every SQL string the tracker PREPARES while `run` executes. */
function capturePrepared(tracker: FileTracker, run: () => void): string[] {
	const db = tracker.getDatabase();
	const original = db.prepare;
	const seen: string[] = [];
	db.prepare = (sql: string) => {
		seen.push(sql);
		return original.call(db, sql);
	};
	try {
		run();
	} finally {
		db.prepare = original;
	}
	return seen;
}

interface PlanRow {
	id: number;
	parent: number;
	detail: string;
}

function explain(tracker: FileTracker, sql: string): PlanRow[] {
	return tracker
		.getDatabase()
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all() as PlanRow[];
}

/** The plan as SQLite's shell draws it, for the log. */
function renderPlan(plan: PlanRow[]): string {
	const depth = new Map<number, number>([[0, -1]]);
	return plan
		.map((row) => {
			const d = (depth.get(row.parent) ?? -1) + 1;
			depth.set(row.id, d);
			return `${"   ".repeat(d)}${row.detail}`;
		})
		.join("\n");
}

/** For each correlated subquery, the access paths directly beneath it. */
function subqueryAccessPaths(plan: PlanRow[]): string[][] {
	return plan
		.filter((row) => row.detail.startsWith("CORRELATED SCALAR SUBQUERY"))
		.map((sub) =>
			plan.filter((row) => row.parent === sub.id).map((row) => row.detail),
		);
}

/** The one `UPDATE symbol_references … SET to_symbol_id` the method prepares. */
function resolveStatementOf(tracker: FileTracker): string {
	const prepared = capturePrepared(tracker, () => {
		tracker.resolveReferencesByName();
	});
	const updates = prepared.filter((sql) =>
		/UPDATE\s+symbol_references\s+SET\s+to_symbol_id/i.test(sql),
	);
	expect(updates).toHaveLength(1);
	return updates[0] as string;
}

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

/**
 * The hand fixture. Every expected value below is derived by hand from this
 * insertion sequence, not read back from the code under test.
 *
 * rowid order after the REPLACE: alpha-a(1) beta-priv(2) beta-b(3)
 * gamma-priv(4) dup-b(6) dup-c(7) dup-a(8) — `dup-a` was re-inserted and moved
 * to the end, so the lowest-rowid exported `dup` is `dup-b`, not the id that
 * was inserted first.
 */
function seedHandFixture(tracker: FileTracker): void {
	tracker.insertSymbols([
		symbol("alpha-a", "alpha", true),
		symbol("beta-priv", "beta", false),
		symbol("beta-b", "beta", true),
		symbol("gamma-priv", "gamma", false),
		symbol("dup-a", "dup", true),
		symbol("dup-b", "dup", true),
		symbol("dup-c", "dup", true),
	]);
	tracker.insertSymbol(symbol("dup-a", "dup", true)); // REPLACE: new rowid
	tracker.insertReferences([
		reference("alpha-a", "alpha"), // 1 → alpha-a
		reference("alpha-a", "beta"), // 2 → beta-b (the private one is skipped)
		reference("alpha-a", "gamma"), // 3 only a private definition: stays
		reference("alpha-a", "missing"), // 4 no definition: stays
		reference("alpha-a", "dup"), // 5 → dup-b, the lowest rowid
		reference("beta-b", "dup"), // 6 → dup-b
		reference("beta-b", "alpha", "beta-b"), // 7 already resolved: untouched
		reference("beta-b", "Alpha"), // 8 BINARY collation: no match, stays
	]);
}

/** A deterministic PRNG, so the generated fixture is the same on every run. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const GENERATED = { symbols: 2000, names: 300, refs: 5000, replaced: 100 };

/**
 * A generated fixture: many duplicate names, mixed exports, 100 REPLACEd rows
 * (half of them flipping `isExported`), references to names that are defined,
 * defined only privately, never defined, or differ only in case, and 10%
 * already resolved.
 */
function seedGeneratedFixture(tracker: FileTracker): void {
	const rand = lcg(0x5eed);
	const symbols: SymbolDefinition[] = [];
	for (let i = 0; i < GENERATED.symbols; i++) {
		symbols.push(
			symbol(
				`sym-${i}`,
				`n${Math.floor(rand() * GENERATED.names)}`,
				rand() < 0.4,
			),
		);
	}
	tracker.insertSymbols(symbols);
	const replaced: SymbolDefinition[] = [];
	for (let i = 0; i < GENERATED.replaced; i++) {
		const original = symbols[
			Math.floor(rand() * GENERATED.symbols)
		] as SymbolDefinition;
		replaced.push({
			...original,
			isExported: i % 2 === 0 ? !original.isExported : original.isExported,
		});
	}
	tracker.insertSymbols(replaced);

	const refs: SymbolReference[] = [];
	for (let i = 0; i < GENERATED.refs; i++) {
		const k = Math.floor(rand() * (GENERATED.names + 100));
		const roll = rand();
		const name = roll < 0.05 ? `N${k}` : `n${k}`;
		const from = `sym-${i % GENERATED.symbols}`;
		refs.push(
			roll > 0.9
				? reference(from, name, `sym-${Math.floor(rand() * GENERATED.symbols)}`)
				: reference(from, name),
		);
	}
	tracker.insertReferences(refs);
}

/**
 * Independent JS oracle: for each unresolved reference, the exported symbol
 * with that exact name and the lowest rowid; otherwise unchanged.
 */
function oracle(tracker: FileTracker): { rows: RefRow[]; changes: number } {
	const symbols = tracker
		.getDatabase()
		.prepare("SELECT id, name, is_exported FROM symbols ORDER BY rowid")
		.all() as Array<{ id: string; name: string; is_exported: number }>;
	const firstExported = new Map<string, string>();
	for (const s of symbols) {
		if (s.is_exported === 1 && !firstExported.has(s.name)) {
			firstExported.set(s.name, s.id);
		}
	}
	let changes = 0;
	const rows = refRows(tracker).map((row) => {
		if (row.is_resolved !== 0) return row;
		const target = firstExported.get(row.to_symbol_name);
		if (target === undefined) return row;
		changes++;
		return { ...row, to_symbol_id: target, is_resolved: 1 };
	});
	return { rows, changes };
}

// ════════════════════════════════════════════════════════════════════════════
// The plan
// ════════════════════════════════════════════════════════════════════════════

describe("resolveReferencesByName — the query plan", () => {
	test("both correlated subqueries SEARCH idx_symbols_name (name=?); neither touches idx_symbols_exported", () => {
		const tracker = openTracker();
		seedGeneratedFixture(tracker);
		const sql = resolveStatementOf(tracker);
		const plan = explain(tracker, sql);
		console.log(`resolveReferencesByName plan:\n${renderPlan(plan)}`);

		expect(subqueryAccessPaths(plan)).toEqual([
			[NAME_INDEX_SEARCH],
			[NAME_INDEX_SEARCH],
		]);
		expect(
			plan.filter((row) => row.detail.includes("idx_symbols_exported")),
		).toEqual([]);
		tracker.close();
	});

	test("premise: on the same database the PRE-FIX statement plans through idx_symbols_exported — the assertion above can tell the two apart", () => {
		const tracker = openTracker();
		seedGeneratedFixture(tracker);
		// No ANALYZE statistics: the state every tracker database is in, since
		// nothing in src/ runs ANALYZE.
		const stat = tracker
			.getDatabase()
			.prepare(
				"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'",
			)
			.get() as { n: number };
		expect(stat.n).toBe(0);

		const plan = explain(tracker, PRE_FIX_SQL);
		console.log(`pre-fix plan:\n${renderPlan(plan)}`);
		expect(subqueryAccessPaths(plan)).toEqual([
			["SEARCH s USING INDEX idx_symbols_exported (is_exported=?)"],
			["SEARCH s USING INDEX idx_symbols_exported (is_exported=?)"],
		]);
		tracker.close();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The result set
// ════════════════════════════════════════════════════════════════════════════

describe("resolveReferencesByName — resolves exactly what the pre-fix statement resolved", () => {
	test("hand fixture: exact rows and counts, derived by hand", () => {
		const tracker = openTracker();
		seedHandFixture(tracker);

		// The premise the LIMIT 1 case rests on: rowid order is not id order.
		expect(
			(
				tracker
					.getDatabase()
					.prepare("SELECT id FROM symbols WHERE name = 'dup' ORDER BY rowid")
					.all() as Array<{ id: string }>
			).map((r) => r.id),
		).toEqual(["dup-b", "dup-c", "dup-a"]);

		expect(tracker.resolveReferencesByName()).toBe(4);
		expect(
			refRows(tracker).map((r) => [
				r.id,
				r.to_symbol_name,
				r.to_symbol_id,
				r.is_resolved,
			]),
		).toEqual([
			[1, "alpha", "alpha-a", 1],
			[2, "beta", "beta-b", 1],
			[3, "gamma", null, 0],
			[4, "missing", null, 0],
			[5, "dup", "dup-b", 1],
			[6, "dup", "dup-b", 1],
			[7, "alpha", "beta-b", 1],
			[8, "Alpha", null, 0],
		]);
		// Idempotent: a second pass has nothing left to resolve.
		expect(tracker.resolveReferencesByName()).toBe(0);
		tracker.close();
	});

	test("generated fixture: identical to the pre-fix statement AND to an independent oracle, row for row", () => {
		// Two databases built by the same deterministic sequence: one resolved
		// by the pre-fix statement text, one by the tracker's method.
		const before = openTracker();
		seedGeneratedFixture(before);
		const after = openTracker();
		seedGeneratedFixture(after);
		expect(refRows(after)).toEqual(refRows(before));

		const expected = oracle(after);

		const preFixChanges = before
			.getDatabase()
			.prepare(PRE_FIX_SQL)
			.run().changes;
		const changes = after.resolveReferencesByName();

		const rows = refRows(after);
		expect(rows).toEqual(refRows(before));
		expect(rows).toEqual(expected.rows);
		expect(changes).toBe(preFixChanges);
		expect(changes).toBe(expected.changes);

		// Exact counts for this seed, pinned. The fixture is not vacuous: it
		// has resolvable, unresolvable and pre-resolved references in bulk.
		const resolved = rows.filter((r) => r.is_resolved === 1).length;
		const unresolved = rows.filter((r) => r.is_resolved === 0).length;
		console.log(
			`generated fixture: changes=${changes} resolved=${resolved} unresolved=${unresolved}`,
		);
		expect(resolved + unresolved).toBe(GENERATED.refs);
		expect({ changes, resolved, unresolved }).toEqual(PINNED_COUNTS);

		before.close();
		after.close();
	});
});

/**
 * For seed 0x5eed and GENERATED above; changing either changes these. Taken
 * from the PRE-FIX statement at HEAD, where the independent oracle agreed with
 * it row for row, so they record the behaviour the fix must preserve.
 */
const PINNED_COUNTS = { changes: 3016, resolved: 3514, unresolved: 1486 };
