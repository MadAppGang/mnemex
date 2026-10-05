/**
 * `equalityInLists` parenthesises its own result (code review 1, LOW 12).
 *
 * Over 256 values it is `col IN (…) OR col IN (…)`. `AND` binds tighter than
 * `OR`, so a caller that joins an UNparenthesised result with `AND` gets
 * `x AND col IN (a) OR col IN (b)` = `(x AND col IN (a)) OR col IN (b)`: every
 * row matching the later lists, whatever `x` says — the silent widening
 * CLAUDE.md #22 is about. The callers parenthesised it, so it was latent; the
 * helper now owns its precedence, so the next caller cannot get it wrong.
 *
 * Code review 2, LOW 9: an EMPTY list rendered `()`, which LanceDB rejects as
 * a parse error. It is now a predicate that matches nothing, checked against a
 * real LanceDB table (and its negation against every row).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	equalityInLists,
	suppressionPredicate,
} from "../../../src/core/store.js";

test("one list and many lists are both a single parenthesised term", () => {
	expect(equalityInLists("filePath", ["src/a.ts"])).toBe(
		"(filePath IN ('src/a.ts'))",
	);
	const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
	const predicate = equalityInLists("filePath", many);
	expect(predicate.startsWith("(filePath IN (")).toBe(true);
	expect(predicate.endsWith("'src/f299.ts'))")).toBe(true);
	expect(predicate.split(" OR ").length).toBe(2);
	// Its parentheses balance, and the outermost pair encloses the whole OR.
	let depth = 0;
	let minInside = Number.POSITIVE_INFINITY;
	for (let i = 0; i < predicate.length; i++) {
		if (predicate[i] === "(") depth++;
		if (predicate[i] === ")") depth--;
		if (i > 0 && i < predicate.length - 1)
			minInside = Math.min(minInside, depth);
	}
	expect(depth).toBe(0);
	expect(minInside).toBeGreaterThanOrEqual(1);
});

test("equality escaping is unchanged: quote-doubling only (#22)", () => {
	expect(equalityInLists("filePath", ["src/my_file's.ts"])).toBe(
		"(filePath IN ('src/my_file''s.ts'))",
	);
	expect(suppressionPredicate(["src/my_file's.ts"])).toBe(
		"NOT (pathKind = 'repo' AND (filePath IN ('src/my_file''s.ts')))",
	);
});

test("an EMPTY list matches nothing — valid SQL to a real LanceDB table (LOW 9)", async () => {
	const predicate = equalityInLists("filePath", []);
	expect(predicate).not.toContain("()");
	const dir = mkdtempSync(join(tmpdir(), "mnemex-eq-empty-"));
	try {
		const db = await lancedb.connect(dir);
		const table = await db.createTable("t", [
			{ filePath: "src/a.ts", n: 1 },
			{ filePath: "src/b.ts", n: 2 },
		]);
		expect(await table.countRows(predicate)).toBe(0);
		expect(await table.countRows(`NOT ${predicate}`)).toBe(2);
		expect(await table.countRows(`n > 0 AND ${predicate}`)).toBe(0);
		table.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
