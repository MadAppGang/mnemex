/**
 * D6, parts 1 and 2 — the two things that keep NFR-5 under a shared corpus,
 * pinned statically because both fail SILENTLY.
 *
 * ── PART 1: THE FILTER IS A PRE-FILTER, ON BOTH RETRIEVERS ──────────────────
 * The branch predicate goes into the same `filters: string[]` array that
 * already carries `language` and `pathPattern`, and that array is handed to
 * `.where()` on the `vectorSearch` query AND on the `fullTextSearch` query. A
 * foreign row then never enters the candidate set, never consumes a `limit`
 * slot and never displaces a visible row.
 *
 * A POST-filter would be a far larger NFR-5 break than any statistical drift:
 * it silently returns FEWER than `limit` results and changes WHICH rows come
 * back, not merely their order. `postfilter()` is opt-in on LanceDB's vector
 * query (`query.d.ts:391-411`), so the way to get this wrong is to call it —
 * which is why the identifier must not appear in `store.ts` at all. The FTS
 * query has no `postfilter` to call, so that half is held by
 * `lancedb-fts-prefilter.test.ts`'s measured probe (V6.4) and by V3.3, whose
 * fixture matches the foreign file BY KEYWORD as well as by vector.
 *
 * ── PART 2: THE FUSION CONSUMES RANKS, NEVER SCORES ─────────────────────────
 * This is the fact that collapses most of the concern. `typeAwareRRFFusion`
 * sets `vectorScore = 1 / (i + 1)` and `keywordScore = 1 / (i + 1)` where `i`
 * is the POSITION IN THE LIST. No BM25 `_score` and no vector `_distance` is
 * ever read. So an absolute shift in BM25 scores — the thing a changed corpus
 * most obviously causes — is STRUCTURALLY INVISIBLE to the final ordering.
 *
 * "Improving" the fusion to use raw scores would re-open that channel, and it
 * would do so silently: every test would still pass, and the only symptom
 * would be rankings that move for reasons nobody can explain. Hence the pin.
 *
 * FALSIFIED BY: adding `postfilter` to `store.ts`, or reading `_distance` in
 * either fusion function. Both shapes are run against fixtures below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STORE = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"src",
	"core",
	"store.ts",
);
const SOURCE = readFileSync(STORE, "utf8");

/** Comments blanked, offsets preserved. Prose about `postfilter` is not a call. */
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
		} else {
			i++;
		}
	}
	return out.join("");
}

/** The body of a top-level `function <name>(` … matching brace. */
export function functionBody(source: string, name: string): string {
	const header = new RegExp(`^function ${name}\\s*\\(`, "m").exec(source);
	if (header === null) throw new Error(`no such function: ${name}`);
	const open = source.indexOf("{", source.indexOf(")", header.index));
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	throw new Error(`unbalanced body: ${name}`);
}

/** `_score` / `_distance` / `_relevance` as IDENTIFIERS, not as substrings. */
export function rawScoreReads(body: string): string[] {
	return [...body.matchAll(/\b_(?:score|distance|relevance)\b/g)].map(
		(m) => m[0],
	);
}

/** The two fusion functions §4.4.3 pins, by name. */
const FUSION_FUNCTIONS = ["reciprocalRankFusion", "typeAwareRRFFusion"];

describe("D6 part 1 — no postfilter in store.ts", () => {
	test("the identifier does not appear in code", () => {
		const code = codeOnly(SOURCE);
		expect([...code.matchAll(/\bpostfilter\b/gi)]).toEqual([]);
	});

	test("the sweep is not vacuous: it still sees prose about it in the comments", () => {
		// The rule is worth a sentence next to the code it constrains, and the
		// comment must NOT make the sweep fire — so both halves are checked.
		expect(SOURCE).toContain("postfilter");
	});

	test("guarding the guard: a real call IS named", () => {
		const fixture = "const q = table.vectorSearch(v).postfilter().limit(5);";
		expect([...codeOnly(fixture).matchAll(/\bpostfilter\b/gi)]).toHaveLength(1);
	});
});

describe("D6 part 2 — the fusion consumes RANKS, never scores", () => {
	for (const name of FUSION_FUNCTIONS) {
		test(`${name} reads no _score, _distance or _relevance`, () => {
			expect(rawScoreReads(functionBody(codeOnly(SOURCE), name))).toEqual([]);
		});

		test(`${name} really does compute 1 / (i + 1)`, () => {
			// Not vacuous: the absence above is only meaningful if the function
			// is in fact rank-based. §4.4.3 says this is "verifiable in three
			// lines of the tree" — these are those lines.
			const body = functionBody(codeOnly(SOURCE), name);
			expect(body).toMatch(/1\s*\/\s*\(\s*\w+\s*\+\s*1\s*\)/);
		});
	}

	test("guarding the guard: reading a raw distance IS named", () => {
		const fixture = `
function typeAwareRRFFusion(rows) {
	return rows.map((r, i) => ({ ...r, vectorScore: 1 / (r._distance + 1) }));
}
`;
		expect(rawScoreReads(functionBody(fixture, "typeAwareRRFFusion"))).toEqual([
			"_distance",
		]);
	});
});
