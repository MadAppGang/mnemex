/**
 * W1's delete clause of V2.10, statically (architecture §3.5, §4.1.1).
 *
 * W1 fixes the order between the two stores that cannot be committed together:
 * the LanceDB row goes first and the SQLite state that makes it findable
 * second. The whole invariant rests on there being ONE removal path, so an
 * unscoped `table.delete(` anywhere else is not a style problem — in a store
 * shared by several branches it deletes rows that other branches still point
 * at, and `chunk_branches` keeps naming them for ever.
 *
 * TWO RULES, over comment- and string-stripped `src/`:
 *
 *   W1-a  `table.delete(` appears only at the sites listed in
 *         `DELETE_SITES` below, each with the reason it is legitimate.
 *   W1-b  `DELETE FROM chunk_index` appears only in `FileTracker`'s
 *         `finishNarrowBatch` — `narrowIds`' own transaction, the one place
 *         that knows an id became an orphan.
 *
 * ── WHY THIS FILE EXISTS ONLY NOW ───────────────────────────────────────────
 * `deleteByFileHash`, `deleteByDocumentType` and `deleteAllByFile` were three
 * unscoped deletes with no caller in `src/`. Written before they were retired,
 * this sweep would have needed three allowlist entries whose only justification
 * was "nothing calls it" — a deferral wearing a justification's clothes
 * (`briefs/phase-3b-inputs.md` §7, decision I-15). They were retired first, so
 * every entry below states a property of the call, not a plan.
 *
 * FALSIFIED BY: adding `table.delete(` to any function not on the list, and by
 * moving the `chunk_index` delete out of `finishNarrowBatch`. Both shapes are
 * run against fixtures in "guarding the guards", and the non-vacuity test
 * proves each listed site is really present in the tree it claims to describe.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Every function in `src/` that may call `table.delete(`, and WHY.
 *
 * "No caller" is not a reason and may not appear here: a method nothing calls
 * is retired, not allowlisted.
 */
const DELETE_SITES: ReadonlyArray<{
	readonly file: string;
	readonly fn: string;
	readonly reason: string;
}> = [
	{
		file: "src/core/store.ts",
		fn: "deleteByIds",
		reason:
			"W1's removal itself. Its only callers are `narrowIds` (the orphan half of §4.1.1's narrow, the sweep and `removeFileFromBranch`) and recovery's add-undo (§4.1.4), both in branch-membership.ts. The ids it is given are exactly those whose membership emptied, computed under the store lock from `chunk_branches`",
	},
	{
		file: "src/core/store.ts",
		fn: "deleteByFile",
		reason:
			"the DOCS row class, which §3.2.1 says is neither widened nor swept. All four callers render `docs:<package>` (cli.ts `docs clear`/`docs fetch`, indexer.ts's docs refresh); a repository row's `filePath` is a repo-relative source path and can never equal one, so this predicate cannot reach a row `chunk_index` registered. Dedup for docs comes from `indexed_docs`, which is repository-scoped under `branch_id = 0`",
	},
	{
		file: "src/core/store.ts",
		fn: "restoreAfterFailedUpdate",
		reason:
			"the same-id update round-trip. LanceDB has no upsert, so an in-place update is delete+add of ONE row addressed by `id = '<the id being updated>'`; this is the re-delete that makes the restore converge on exactly one row. It removes no membership and no row that was not about to be re-added",
	},
	{
		file: "src/core/store.ts",
		fn: "updateUnitSummary",
		reason:
			"the same-id update round-trip: `id = '<unitId>'`, immediately followed by `table.add` of the same row with a new `summary`. Membership travels in `branchIds`, which the round-trip carries forward untouched",
	},
	{
		file: "src/core/store.ts",
		fn: "updateDocumentContent",
		reason:
			"the same-id update round-trip: `id = '<documentId>'`, immediately followed by `table.add` of the same row with new content and vector",
	},
];

/** W1-b: the only two functions allowed to delete a `chunk_index` row. */
const CHUNK_INDEX_DELETE_SITES: ReadonlyArray<{
	readonly file: string;
	readonly fn: string;
	readonly reason: string;
}> = [
	{
		file: "src/core/tracker.ts",
		fn: "finishNarrowBatch",
		reason:
			"R7 of §4.1.1's narrow: the ids whose membership just emptied, in the SAME transaction that drops this branch's `chunk_branches` rows and clears the `'remove'` intents. This is the only site that removes an INDIVIDUAL id, and one removed anywhere else would break P1 in the direction that strands a live LanceDB row",
	},
	{
		file: "src/core/tracker.ts",
		fn: "clear",
		reason:
			"the whole-store reset (§4.5's `rebuildStore`, the corruption and model-change branches). Every caller has just dropped the LanceDB table or is about to, and a `chunk_index` that outlives a cleared dataset makes the tier-1 hit test WIDEN ids whose rows no longer exist. It removes no individual id: the statement has no WHERE clause, and `chunk_branches` and `chunk_write_intent` go in the same transaction",
	},
];

/**
 * Blank comments and the CONTENTS of string and template literals, keeping
 * every newline and every other offset, so line numbers and brace matching
 * still line up with the original. Prose naming `table.delete(` is not a call,
 * and neither is a SQL string that happens to contain one.
 *
 * A `'` OR `"` IS LINE-BOUNDED, and that is not tidiness — it is what makes
 * this usable on `store.ts` at all. A JavaScript single- or double-quoted
 * string cannot contain a raw newline, but a REGEX LITERAL can contain a
 * quote: `store.ts:417` is `.replace(/'/g, "''")`. A scanner that pairs that
 * apostrophe with the next one anywhere in the file blanks hundreds of lines,
 * and both `deleteByIds` and three real `table.delete(` calls vanished from the
 * sweep's view — a sweep that passes by seeing nothing. So a quote with no
 * partner on its own line is treated as an ordinary character, which bounds the
 * damage of a regex literal to the line it sits on. Backticks stay multi-line,
 * because template literals genuinely are.
 */
function codeOnly(source: string): string {
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
			const close = closingQuote(source, i);
			if (close === null) {
				i++;
				continue;
			}
			blank(i + 1, close);
			i = close + 1;
		} else {
			i++;
		}
	}
	return out.join("");
}

/**
 * The index of the quote that closes the one at `open`, or `null` when there is
 * none before the end of the line (a backtick may cross lines; the other two
 * may not).
 */
function closingQuote(source: string, open: number): number | null {
	const quote = source[open];
	for (let j = open + 1; j < source.length; j++) {
		const ch = source[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === quote) return j;
		if (ch === "\n" && quote !== "`") return null;
	}
	return null;
}

function matchingClose(code: string, openIndex: number): number {
	const open = code[openIndex];
	const close = open === "(" ? ")" : "}";
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		if (code[i] === open) depth++;
		else if (code[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return code.length;
}

/**
 * `[start, end)` of the body of the method or function named `fn`, found by its
 * DECLARATION at the start of a line — never by its first mention, which in
 * this tree is routinely a call that appears earlier in the file.
 */
function bodySpan(code: string, fn: string): [number, number] | null {
	const header = new RegExp(
		`^[ \\t]*(?:export )?(?:private |public |protected )?(?:static )?(?:async )?(?:function )?${fn}\\s*\\(`,
		"gm",
	);
	for (const match of code.matchAll(header)) {
		const params = code.indexOf("(", match.index ?? 0);
		const afterParams = matchingClose(code, params);
		const body = code.indexOf("{", afterParams);
		const semicolon = code.indexOf(";", afterParams);
		// An INTERFACE member declares the same signature and ends in `;`. Built
		// from that match the span would run from the next unrelated brace to its
		// close, which in `store.ts` swallowed the whole class and made the
		// allowlist permit everything.
		if (body === -1 || (semicolon !== -1 && semicolon < body)) continue;
		return [body, matchingClose(code, body)];
	}
	return null;
}

/** Spans of `code` that the allowlist permits for `file`. */
function allowedSpans(
	file: string,
	code: string,
	sites: ReadonlyArray<{ file: string; fn: string }>,
): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (const site of sites) {
		if (site.file !== file) continue;
		const span = bodySpan(code, site.fn);
		if (span !== null) spans.push(span);
	}
	return spans;
}

interface SourceFile {
	file: string;
	source: string;
}

function violations(
	files: ReadonlyArray<SourceFile>,
	pattern: RegExp,
	sites: ReadonlyArray<{ file: string; fn: string }>,
): string[] {
	const found: string[] = [];
	for (const { file, source } of files) {
		const code = codeOnly(source);
		const spans = allowedSpans(file, code, sites);
		const inside = (at: number) => spans.some(([s, e]) => at > s && at < e);
		for (const hit of code.matchAll(pattern)) {
			const at = hit.index ?? 0;
			if (inside(at)) continue;
			const line = source.slice(0, at).split("\n").length;
			found.push(`${file}:${line} ${source.split("\n")[line - 1].trim()}`);
		}
	}
	return [...new Set(found)].sort();
}

/** `<receiver>.delete(` where the receiver is a LanceDB table handle. */
const TABLE_DELETE = /\b(?:table|tbl|this\.table)\s*\??\.\s*delete\s*\(/g;

/**
 * `DELETE FROM chunk_index`, matched against source with COMMENTS blanked and
 * string contents KEPT: the statement lives inside a string literal, which
 * `codeOnly` blanks, while the prose describing the rule lives in comments,
 * which the raw source keeps. Whitespace-tolerant, because the statements are
 * written across lines.
 */
const CHUNK_INDEX_DELETE = /DELETE\s+FROM\s+chunk_index\b/g;

/** Comments blanked, string CONTENTS preserved. The mirror image of `codeOnly`. */
function stringsKept(source: string): string {
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
			const close = closingQuote(source, i);
			i = close === null ? i + 1 : close + 1;
		} else {
			i++;
		}
	}
	return out.join("");
}

function srcFiles(): SourceFile[] {
	const out: SourceFile[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.tsx?$/.test(entry.name)) {
				out.push({
					file: relative(REPO_ROOT, full),
					source: readFileSync(full, "utf8"),
				});
			}
		}
	};
	walk(join(REPO_ROOT, "src"));
	return out;
}

/** The in-string variant, for the rule whose subject is a SQL literal. */
function sqlViolations(
	files: ReadonlyArray<SourceFile>,
	pattern: RegExp,
	sites: ReadonlyArray<{ file: string; fn: string }>,
): string[] {
	const found: string[] = [];
	for (const { file, source } of files) {
		const code = codeOnly(source);
		const spans = allowedSpans(file, code, sites);
		for (const hit of stringsKept(source).matchAll(pattern)) {
			const at = hit.index ?? 0;
			if (spans.some(([s, e]) => at > s && at < e)) continue;
			const line = source.slice(0, at).split("\n").length;
			found.push(`${file}:${line} ${source.split("\n")[line - 1].trim()}`);
		}
	}
	return [...new Set(found)].sort();
}

describe("W1: every LanceDB delete is on the allowlist, with a reason", () => {
	test("W1-a: table.delete( appears only at the listed sites", () => {
		expect(violations(srcFiles(), TABLE_DELETE, DELETE_SITES)).toEqual([]);
	});

	test("W1-b: DELETE FROM chunk_index appears only at its two sites", () => {
		expect(
			sqlViolations(srcFiles(), CHUNK_INDEX_DELETE, CHUNK_INDEX_DELETE_SITES),
		).toEqual([]);
	});

	test("every allowlist entry states a reason that is not 'no caller'", () => {
		for (const site of [...DELETE_SITES, ...CHUNK_INDEX_DELETE_SITES]) {
			expect(site.reason.length).toBeGreaterThan(40);
			expect(site.reason.toLowerCase()).not.toContain("no caller");
			expect(site.reason.toLowerCase()).not.toContain("not owned by");
		}
	});

	test("the allowlist is not a hiding place: every listed site really deletes", () => {
		const files = srcFiles();
		for (const site of DELETE_SITES) {
			const source = files.find((f) => f.file === site.file)?.source;
			expect(source, `${site.file} is not in src/`).toBeDefined();
			const span = bodySpan(codeOnly(source ?? ""), site.fn);
			expect(span, `${site.file} has no ${site.fn}`).not.toBeNull();
			const body = codeOnly(source ?? "").slice(span?.[0], span?.[1]);
			expect(
				TABLE_DELETE.test(body),
				`${site.fn} is allowlisted but calls no table.delete(`,
			).toBe(true);
			TABLE_DELETE.lastIndex = 0;
		}
		for (const site of CHUNK_INDEX_DELETE_SITES) {
			const tracker = files.find((f) => f.file === site.file)?.source;
			const span = bodySpan(codeOnly(tracker ?? ""), site.fn);
			expect(span, `${site.file} has no ${site.fn}`).not.toBeNull();
			expect(stringsKept(tracker ?? "").slice(span?.[0], span?.[1])).toMatch(
				CHUNK_INDEX_DELETE,
			);
			CHUNK_INDEX_DELETE.lastIndex = 0;
		}
	});

	test("the three retired deletes are gone from src/ entirely", () => {
		// Decision I-15: `deleteByFileHash`, `deleteByDocumentType` and
		// `deleteAllByFile` deleted across every branch of a shared store. They
		// are retired, not allowlisted, and this is what stops them returning
		// under the cover of an entry.
		const named = srcFiles()
			.filter((f) =>
				/\b(?:deleteByFileHash|deleteByDocumentType|deleteAllByFile)\s*\(/.test(
					codeOnly(f.source),
				),
			)
			.map((f) => f.file);
		expect(named).toEqual([]);
	});
});

describe("guarding the guards: each detector fires on the shape it forbids", () => {
	test("a table.delete( outside the allowlist is named", () => {
		expect(
			violations(
				[
					{
						file: "src/core/elsewhere.ts",
						source: "async function wipe() {\n\tawait table.delete(`x`);\n}\n",
					},
				],
				TABLE_DELETE,
				DELETE_SITES,
			),
		).toEqual(["src/core/elsewhere.ts:2 await table.delete(`x`);"]);
	});

	test("a table.delete( in a NON-allowlisted method of an allowlisted file is named", () => {
		const source =
			"class VectorStore {\n" +
			"\tasync deleteByIds(ids: string[]): Promise<number> {\n" +
			"\t\tawait table.delete(hexIdList(ids));\n\t\treturn 0;\n\t}\n" +
			"\tasync nukeEverything(): Promise<void> {\n" +
			"\t\tawait table.delete(`1 = 1`);\n\t}\n}\n";
		expect(
			violations(
				[{ file: "src/core/store.ts", source }],
				TABLE_DELETE,
				DELETE_SITES,
			),
		).toEqual(["src/core/store.ts:7 await table.delete(`1 = 1`);"]);
	});

	test("prose and SQL text naming the call are not calls", () => {
		expect(
			violations(
				[
					{
						file: "src/core/elsewhere.ts",
						source:
							"// never call table.delete( here\nconst sql = `table.delete(x)`;\n",
					},
				],
				TABLE_DELETE,
				DELETE_SITES,
			),
		).toEqual([]);
	});

	test("a DELETE FROM chunk_index outside its two sites is named", () => {
		expect(
			sqlViolations(
				[
					{
						file: "src/core/tracker.ts",
						source:
							"class FileTracker {\n" +
							"\tforget(id: string): void {\n" +
							'\t\tthis.db.prepare("DELETE FROM chunk_index WHERE chunk_id = ?").run(id);\n' +
							"\t}\n}\n",
					},
				],
				CHUNK_INDEX_DELETE,
				CHUNK_INDEX_DELETE_SITES,
			),
		).toHaveLength(1);
	});

	test("a DELETE FROM chunk_index in another file is named", () => {
		expect(
			sqlViolations(
				[
					{
						file: "src/core/branch-sweep.ts",
						source: 'db.exec("DELETE FROM chunk_index");\n',
					},
				],
				CHUNK_INDEX_DELETE,
				CHUNK_INDEX_DELETE_SITES,
			),
		).toHaveLength(1);
	});
	test("a comment naming the statement is prose, not a delete", () => {
		expect(
			sqlViolations(
				[
					{
						file: "src/core/branch-membership.ts",
						source:
							"// the only DELETE FROM chunk_index in src/\nconst x = 1;\n",
					},
				],
				CHUNK_INDEX_DELETE,
				CHUNK_INDEX_DELETE_SITES,
			),
		).toEqual([]);
	});
});
