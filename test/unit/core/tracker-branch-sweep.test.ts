/**
 * V3.11b — EVERY statement on a tree-scoped table names `branch_id`.
 *
 * ── WHY A SWEEP AND NOT A LIST ──────────────────────────────────────────────
 * Revision 1 of the design listed six symbol-graph members and missed six more
 * in the same 400-line span; the orchestrator settled it by measuring that
 * `deleteSymbolsByFile`, `getSymbol`, `getSymbolsByFile`, `getSymbolsByParent`,
 * `updatePageRankScores` and `updateDegreeCounts` appeared ZERO times across
 * 2 141 lines of the architecture. The failure was not the list — it was that
 * the list had been assembled by READING. So the enforcement is generated, and
 * it is generated the same way the inventory was: by TABLE NAME, so a statement
 * cannot be missed by nobody thinking of the method it sits in.
 *
 * Nineteen of the 24 graph members kept compiling unchanged when the key became
 * `(branch_id, id)` and would have gone silently cross-branch. The compile-time
 * half of the fix is `BranchScopedGraph` — there is no expression that reaches a
 * graph statement without naming a branch. THIS is the other half: it covers the
 * 26th statement nobody has written yet, on both table lists.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 * Over comment-stripped `src/core/tracker.ts`, EVERY string or template literal
 * that starts with a SQL verb — not only the ones written inline as a
 * `.prepare(` argument, because the DDL lives in module constants and the
 * batched invalidation statements are built by callbacks — that matches
 *
 *     /(FROM|INTO|UPDATE|JOIN)\s+(symbols|symbol_references|graph_metadata)\b/
 *
 * must also contain `branch_id`, and likewise for the second table list
 * `files|documents|indexed_docs`. The DDL families and `clear()`'s three
 * whole-store DELETEs are the declared exceptions, named below with the reason
 * each is legitimate, and each single-statement exemption is pinned to exactly
 * one occurrence so it cannot quietly cover a second.
 *
 * ── WHAT IT ALREADY CAUGHT ──────────────────────────────────────────────────
 * `getAllFiles` and `getStats`. Both had their `branchId` parameter added to
 * `IFileTracker` and to every CALLER, and both kept their unscoped bodies —
 * TypeScript accepts a method that declares FEWER parameters than the interface
 * it satisfies, so `getStats(branchId)` type-checked while ignoring the
 * argument and `getAllFiles(branchId)` returned every branch's files. That is
 * exactly the "keeps compiling and silently goes cross-branch" shape §4.4.1
 * counts nineteen of, and nothing but this sweep saw it.
 *
 * ── FALSIFIED BY ────────────────────────────────────────────────────────────
 * removing `branch_id = ?` from any one statement — the sweep names that line.
 * The "guarding the guard" block at the bottom runs that shape on a fixture on
 * every run, so a sweep that stopped detecting anything cannot pass quietly.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRACKER = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"src",
	"core",
	"tracker.ts",
);

/** The two table lists, each generated from §4.4.1's own grep. */
const TABLE_GROUPS = {
	"symbol graph": ["symbols", "symbol_references", "graph_metadata"],
	"files / documents / indexed_docs": ["files", "documents", "indexed_docs"],
} as const;

/**
 * The declared exceptions, each with the reason it is legitimate — an
 * exemption added to make a sweep pass is itself a defect
 * (`phase-3b-inputs.md` section 7).
 *
 * Every entry is a SQL fragment that must appear in the statement. They are
 * matched, not listed by line number: a line number goes stale on the next
 * edit and then exempts whatever moved into its place.
 */
type Exemption =
	/** Every statement whose first word matches — a whole DDL family. */
	| { readonly startsWith: string; readonly why: string }
	/** ONE statement, matched in full and asserted to occur exactly once. */
	| { readonly exactly: string; readonly why: string };

const EXEMPT: readonly Exemption[] = [
	{
		startsWith: "CREATE TABLE IF NOT EXISTS",
		why: "DDL declares the `branch_id` column rather than predicating on it. The column list is asserted separately, below.",
	},
	{
		startsWith: "CREATE INDEX IF NOT EXISTS",
		why: "DDL. Which indexes lead with `branch_id` is asserted separately, below.",
	},
	{
		startsWith: "DROP TABLE IF EXISTS",
		why: "the §3.5.1 rebuild pass drops the WHOLE table; a branch predicate on a DROP is not expressible and not wanted.",
	},
	{
		startsWith: "ALTER TABLE",
		why: "the pre-v4 column migration, which by definition runs before a `branch_id` column exists.",
	},
	{
		startsWith: "PRAGMA table_info",
		why: "a schema probe, not a row statement.",
	},
	{
		exactly: "DELETE FROM files",
		why: "`clear()` — the WHOLE store. Reached only through `rebuildStore`'s producers (§4.5), never from a per-branch path. §4.4.1 names `clear` as the one exception. Matched in full and pinned to ONE occurrence, so a second unscoped `DELETE FROM files` written anywhere else is still a finding.",
	},
	{
		exactly: "DELETE FROM documents",
		why: "`clear()`, as above.",
	},
	{
		exactly: "DELETE FROM indexed_docs",
		why: "`clear()`, as above. `clearAllIndexedDocs` is the SCOPED one and carries `branch_id = 0`.",
	},
];

function exemptionOf(sql: string): Exemption | undefined {
	const trimmed = sql.trim();
	return EXEMPT.find((e) =>
		"exactly" in e ? trimmed === e.exactly : trimmed.startsWith(e.startsWith),
	);
}

/**
 * Blank out comments, keeping every other character's offset so line numbers
 * still line up with the original. String CONTENTS are kept — they are the
 * statements this sweep reads.
 */
function stripComments(source: string): string {
	const out = source.split("");
	let i = 0;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end < 0 ? source.length : end;
			blank(i, stop);
			i = stop;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
		} else if (c === '"' || c === "'" || c === "`") {
			// Skip the literal wholesale: a `//` or `/*` inside it is not a comment.
			let j = i + 1;
			while (j < source.length && source[j] !== c) {
				j += source[j] === "\\" ? 2 : 1;
			}
			i = j + 1;
		} else {
			i++;
		}
	}
	return out.join("");
}

interface Statement {
	readonly line: number;
	readonly sql: string;
}

/**
 * EVERY SQL statement in the file, wherever it is written.
 *
 * Not "the argument of `.prepare(`": the DDL lives in module constants
 * (`FILES_TABLE_DDL`, `SYMBOL_GRAPH_DDL`, `BRANCH_LEADING_INDEX_DDL`) and the
 * batched invalidation statements are built by callbacks. Scanning every string
 * and template literal and keeping the ones that START with a SQL verb is a
 * SUPERSET of the statements the tracker runs, which is the right direction for
 * a sweep: a statement cannot escape by being written somewhere new.
 */
const SQL_VERB =
	/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i;

export function sqlStatements(source: string): Statement[] {
	const code = stripComments(source);
	const found: Statement[] = [];
	let i = 0;
	while (i < code.length) {
		const c = code[i];
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < code.length && code[j] !== c) {
				j += code[j] === "\\" ? 2 : 1;
			}
			const body = code.slice(i + 1, j);
			if (SQL_VERB.test(body.trim())) {
				found.push({ line: code.slice(0, i).split("\n").length, sql: body });
			}
			i = j + 1;
		} else {
			i++;
		}
	}
	return found;
}

/** `line: first line of sql` for every statement that touches a table unscoped. */
export function unscopedStatements(
	source: string,
	tables: readonly string[],
): string[] {
	const touches = new RegExp(
		`(FROM|INTO|UPDATE|JOIN)\\s+(${tables.join("|")})\\b`,
		"i",
	);
	const violations: string[] = [];
	for (const { line, sql } of sqlStatements(source)) {
		if (!touches.test(sql)) continue;
		if (sql.includes("branch_id")) continue;
		if (exemptionOf(sql) !== undefined) continue;
		violations.push(`${line}: ${sql.trim().split("\n")[0].trim()}`);
	}
	return violations;
}

const SOURCE = readFileSync(TRACKER, "utf8");

describe("V3.11b — every tree-scoped statement names branch_id", () => {
	for (const [label, tables] of Object.entries(TABLE_GROUPS)) {
		test(`${label}: no unscoped statement`, () => {
			expect(unscopedStatements(SOURCE, tables)).toEqual([]);
		});
	}

	test("the sweep is not vacuous: it really saw the tracker's statements", () => {
		const statements = sqlStatements(SOURCE);
		// Well over a hundred statements live in this file.
		expect(statements.length).toBeGreaterThan(100);
		const graph = statements.filter((s) =>
			/(FROM|INTO|UPDATE|JOIN)\s+(symbols|symbol_references|graph_metadata)\b/i.test(
				s.sql,
			),
		);
		// The 24 graph members issue more than 24 statements between them.
		expect(graph.length).toBeGreaterThanOrEqual(24);
		expect(graph.every((s) => s.sql.includes("branch_id"))).toBe(true);
	});

	test("every exemption is USED, so none is a stale licence", () => {
		const statements = sqlStatements(SOURCE);
		const unused = EXEMPT.filter(
			(e) => !statements.some((s) => exemptionOf(s.sql) === e),
		).map((e) => ("exactly" in e ? e.exactly : e.startsWith));
		expect(unused).toEqual([]);
	});

	test("each single-statement exemption covers EXACTLY ONE statement", () => {
		// An `exactly` entry licenses one line of SQL. If a second copy appears
		// anywhere — a new unscoped `DELETE FROM files` — this fires rather than
		// letting the old exemption quietly cover it too.
		const statements = sqlStatements(SOURCE);
		const counts = EXEMPT.filter(
			(e): e is Extract<Exemption, { exactly: string }> => "exactly" in e,
		).map((e) => [
			e.exactly,
			statements.filter((s) => s.sql.trim() === e.exactly).length,
		]);
		expect(counts).toEqual([
			["DELETE FROM files", 1],
			["DELETE FROM documents", 1],
			["DELETE FROM indexed_docs", 1],
		]);
	});
});

describe("V3.11b — the v4 DDL declares what the predicates rely on", () => {
	test("every tree-scoped table declares branch_id NOT NULL", () => {
		for (const table of [
			"files",
			"documents",
			"indexed_docs",
			"symbols",
			"symbol_references",
			"graph_metadata",
		]) {
			const ddl = sqlStatements(SOURCE).find((s) =>
				s.sql.trim().startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`),
			);
			expect(ddl, `${table} has no CREATE TABLE`).toBeDefined();
			expect(ddl?.sql).toContain("branch_id INTEGER NOT NULL");
		}
	});

	test("the three symbol-graph FOREIGN KEYs are gone (N33)", () => {
		// `symbols(id)` is no longer a unique single-column key, so a FK naming
		// it is not declarable; and a cross-branch ON DELETE CASCADE is the data
		// loss this phase closes.
		const graphDdl = sqlStatements(SOURCE).filter(
			(s) =>
				s.sql.trim().startsWith("CREATE TABLE IF NOT EXISTS symbols (") ||
				s.sql
					.trim()
					.startsWith("CREATE TABLE IF NOT EXISTS symbol_references ("),
		);
		expect(graphDdl).toHaveLength(2);
		for (const { sql } of graphDdl) expect(sql).not.toContain("FOREIGN KEY");
	});

	test("every index on a branch-keyed table LEADS with branch_id", () => {
		const indexes = sqlStatements(SOURCE).filter((s) =>
			s.sql.trim().startsWith("CREATE INDEX IF NOT EXISTS"),
		);
		expect(indexes.length).toBeGreaterThanOrEqual(14);
		/**
		 * The indexes that deliberately do NOT lead with `branch_id`, each with
		 * the reason. Anything else on a branch-keyed table must.
		 */
		const NOT_BRANCH_LEADING: Record<string, string> = {
			idx_files_content_hash:
				"content-hash lookup is cross-branch by nature: identical content on two branches is ONE hash.",
			idx_files_path:
				"I-12 Ruling 2: D1's unknown-branch fallback drops the branch filter by design, so a path-only lookup exists in the END state and needs its own index.",
			idx_indexed_docs_fetched:
				"external docs are repository-scoped and all carry branch 0, so a leading branch column would be a constant.",
			idx_documents_stale:
				"a migration index on a nullable provenance column; every row it holds is already narrowed by the statement's own branch predicate.",
			idx_documents_invalidated: "as idx_documents_stale.",
			idx_commits_ordinal:
				"`commits` is REPOSITORY-scoped (§3.5) and carries no branch id.",
			idx_activity_log_id:
				"`activity_log` is repository-scoped (§3.5) and carries no branch id.",
		};
		const offenders: string[] = [];
		for (const { sql } of indexes) {
			const name = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)?.[1] ?? "?";
			if (name in NOT_BRANCH_LEADING) continue;
			if (!/\(\s*branch_id\s*,/.test(sql)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Guarding the guard: the detector fires on the shape it exists to catch
// ════════════════════════════════════════════════════════════════════════════

describe("guarding the guard", () => {
	test("dropping the branch predicate from one statement is named, with its line", () => {
		const broken = SOURCE.replace(
			'"SELECT * FROM symbols WHERE branch_id = ? AND id = ?"',
			'"SELECT * FROM symbols WHERE id = ?"',
		);
		expect(broken).not.toBe(SOURCE);
		const findings = unscopedStatements(broken, TABLE_GROUPS["symbol graph"]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain("SELECT * FROM symbols WHERE id = ?");
	});

	test("a NEW unscoped statement, of a shape nobody has written, is named", () => {
		const fixture = `
			class X {
				m() {
					this.db.prepare("SELECT count(*) FROM graph_metadata").get();
				}
			}
		`;
		expect(
			unscopedStatements(fixture, TABLE_GROUPS["symbol graph"]),
		).toHaveLength(1);
	});

	test("the files/documents list fires independently of the graph list", () => {
		const fixture = `
			this.db.prepare("UPDATE documents SET x = 1 WHERE id = ?").run(id);
		`;
		expect(unscopedStatements(fixture, TABLE_GROUPS["symbol graph"])).toEqual(
			[],
		);
		expect(
			unscopedStatements(
				fixture,
				TABLE_GROUPS["files / documents / indexed_docs"],
			),
		).toHaveLength(1);
	});

	test("a scoped statement of the same shape is NOT named", () => {
		const fixture = `
			this.db.prepare("UPDATE documents SET x = 1 WHERE branch_id = ? AND id = ?").run(b, id);
		`;
		expect(
			unscopedStatements(
				fixture,
				TABLE_GROUPS["files / documents / indexed_docs"],
			),
		).toEqual([]);
	});

	test("a statement inside a COMMENT is not mistaken for code", () => {
		const fixture = `
			// this.db.prepare("SELECT * FROM symbols WHERE id = ?")
			/* this.db.exec("DELETE FROM symbols") */
		`;
		expect(sqlStatements(fixture)).toEqual([]);
	});
});
