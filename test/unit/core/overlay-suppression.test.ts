/**
 * Step 3, phase 5 — stale-row suppression (R3.3), store level.
 *
 * `NOT (pathKind = 'repo' AND filePath IN (<suppressed>))` joins the branch
 * predicate in the SAME `filters` array, so it is a PRE-filter on both
 * retrievers: a stale row never takes a candidate slot. Paths are STORED
 * (repo-relative) and compared by equality, so they take `escapeSqlLiteral`
 * (CLAUDE.md #22) — `escapeFilterValue` would render `my\_file''s.ts` and
 * match nothing.
 *
 *   X-1    a modified file: none of its index rows is returned; the count of
 *          rows suppressed is POSITIVE and exact (A)
 *   X-2    a deleted file: the same, and it contributes nothing else (A)
 *   X-3    `src/my_file's.ts` (underscore AND quote): suppressed, count > 0 (A)
 *   OBS-1  an observation whose `affectedFiles[0]` is a served path stays
 *          visible: observations are `pathKind: "synthetic"`, authored data,
 *          never stale (MEDIUM 1) (A)
 *   SUM    summary rows of a suppressed file go with it
 *   CAP    > 256 suppressed paths: still one pre-filter, every path honoured
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRANCH_ID_SHARED,
	branchScope,
	SCOPE_ALL,
} from "../../../src/core/branch-scope.js";
import {
	createVectorStore,
	escapeFilterValue,
	escapeSqlLiteral,
	type IVectorStore,
	suppressionPredicate,
} from "../../../src/core/store.js";
import {
	chunk,
	doc,
	emptyOverlayCandidates,
	hexId,
	overlayCandidatesFrom,
	recordTableCalls,
	vec,
} from "../../helpers/store-search-fixture.js";

const B1 = branchScope(1);
const REPO1 = { pathKind: "repo" as const, branchId: 1 };
const REPO2 = { pathKind: "repo" as const, branchId: 2 };

let dir: string;
let index: IVectorStore;
let overlayStore: IVectorStore;

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mnemex-ovsupp-")));
	index = createVectorStore({
		vectorsDir: join(dir, "vectors"),
		pathRoot: dir,
	});
	await index.initialize();
	overlayStore = createVectorStore({
		vectorsDir: join(dir, "dirty-overlay", "vectors"),
		pathRoot: dir,
		role: "overlay",
	});
	await overlayStore.initialize();
});

afterEach(async () => {
	await index.close();
	await overlayStore.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Every row matches the query by keyword AND sits near the query vector. */
function fileRows(path: string, n: number, near = 2) {
	return Array.from({ length: n }, (_, i) =>
		chunk({
			path,
			label: `${path}#${i}`,
			near: near + i * 0.1,
			name: `fn${i}`,
			startLine: 1 + i * 10,
			endLine: 5 + i * 10,
			content: `function fn${i}() { return marmotword; } // ${path} ${i}`,
		}),
	);
}

const rel = (abs: string | undefined) => (abs ?? "").slice(dir.length + 1);

describe("X-1 / X-2 — modified and deleted files: no stale rows, count > 0", () => {
	test("modified (served) + deleted: none of their index rows returned; suppressed count exact (A)", async () => {
		await index.addChunks(
			[
				...fileRows("src/modified.ts", 3),
				...fileRows("src/deleted.ts", 2),
				...fileRows("src/clean.ts", 2, 3),
			],
			REPO1,
		);
		const visibleBefore = await index.search("marmotword", vec(1), B1, {
			limit: 20,
		});
		expect(new Set(visibleBefore.map((r) => rel(r.chunk.filePath)))).toEqual(
			new Set(["src/modified.ts", "src/deleted.ts", "src/clean.ts"]),
		);

		const edited = chunk({
			path: "src/modified.ts",
			label: "edited",
			near: 2.05,
			name: "editedFn",
			content: "function editedFn() { return marmotword + 1; }",
		});
		const overlay = await overlayCandidatesFrom({
			overlayStore,
			queryVector: vec(1),
			served: [{ path: "src/modified.ts", chunks: [edited] }],
			deleted: ["src/deleted.ts"],
		});
		expect(overlay.suppressedPaths).toEqual([
			"src/deleted.ts",
			"src/modified.ts",
		]);

		const after = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 20 },
			overlay,
		);
		const indexRows = after.filter((r) => r.source !== "dirty");
		expect(indexRows.map((r) => rel(r.chunk.filePath)).sort()).toEqual([
			"src/clean.ts",
			"src/clean.ts",
		]);
		expect(
			after.filter((r) => r.source === "dirty").map((r) => r.chunk.id),
		).toEqual([edited.id]);
		// R3.3: a POSITIVE count, never just "no crash".
		expect(
			await index.countRowsForStoredPaths(B1, overlay.suppressedPaths),
		).toBe(5);
		expect(await index.countRowsForStoredPaths(B1, ["src/modified.ts"])).toBe(
			3,
		);
		expect(await index.countRowsForStoredPaths(B1, ["src/deleted.ts"])).toBe(2);
		expect(await index.countRowsForStoredPaths(B1, [])).toBe(0);
	});

	test("the suppression is a PRE-filter on BOTH retrievers: `limit` is still filled (A)", async () => {
		// 30 stale rows nearer the query than the 5 clean ones would take every
		// candidate slot under a post-filter.
		await index.addChunks(
			[...fileRows("src/stale.ts", 30, 1.1), ...fileRows("src/clean.ts", 5, 4)],
			REPO1,
		);
		const overlay = {
			...emptyOverlayCandidates(),
			suppressedPaths: ["src/stale.ts"],
		};
		const log = await recordTableCalls(index);
		const results = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 5 },
			overlay,
		);
		expect(results.length).toBe(5);
		expect(results.every((r) => rel(r.chunk.filePath) === "src/clean.ts")).toBe(
			true,
		);
		const wheres = log
			.filter((c) => c.method === "where")
			.map((c) => String(c.args[0]));
		expect(wheres.length).toBe(2); // the vector query AND the FTS query
		for (const w of wheres) {
			expect(w).toContain(
				"NOT (pathKind = 'repo' AND (filePath IN ('src/stale.ts')))",
			);
			expect(w).toContain("branchIds LIKE '%,1,%'");
		}
	});

	test("the count is branch-scoped; SCOPE_ALL counts every branch", async () => {
		await index.addChunks(fileRows("src/m.ts", 2), REPO1);
		await index.addChunks(
			fileRows("src/m.ts", 3, 5).map((c) => ({
				...c,
				id: hexId(`b2:${c.id}`),
			})),
			REPO2,
		);
		expect(await index.countRowsForStoredPaths(B1, ["src/m.ts"])).toBe(2);
		expect(
			await index.countRowsForStoredPaths(branchScope(2), ["src/m.ts"]),
		).toBe(3);
		expect(await index.countRowsForStoredPaths(SCOPE_ALL, ["src/m.ts"])).toBe(
			5,
		);
	});
});

describe("X-3 — a path with an underscore AND a quote", () => {
	const NASTY = "src/my_file's.ts";

	test("`src/my_file's.ts`: suppressed, count > 0 (A)", async () => {
		await index.addChunks(
			[...fileRows(NASTY, 2), ...fileRows("src/myXfile's.ts", 1, 3)],
			REPO1,
		);
		expect(await index.countRowsForStoredPaths(B1, [NASTY])).toBe(2);
		const overlay = { ...emptyOverlayCandidates(), suppressedPaths: [NASTY] };
		const results = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 10 },
			overlay,
		);
		expect(results.map((r) => rel(r.chunk.filePath))).toEqual([
			"src/myXfile's.ts",
		]);
	});

	test("the predicate quote-doubles and nothing else; the LIKE escaper would differ", () => {
		const p = suppressionPredicate([NASTY]);
		expect(p).toBe(
			`NOT (pathKind = 'repo' AND (filePath IN ('${escapeSqlLiteral(NASTY)}')))`,
		);
		expect(p).toContain("my_file''s.ts");
		expect(p).not.toContain(escapeFilterValue(NASTY));
		expect(suppressionPredicate([])).toBeNull();
	});
});

describe("CAP — more than 256 suppressed paths", () => {
	test("split across IN lists inside ONE predicate; every path honoured", async () => {
		const many = Array.from({ length: 300 }, (_, i) => `src/gen/f${i}.ts`);
		const p = suppressionPredicate(many) ?? "";
		expect(p.match(/filePath IN \(/g)?.length).toBe(2);
		expect(p.startsWith("NOT (pathKind = 'repo' AND (filePath IN (")).toBe(
			true,
		);
		expect(p).toContain(") OR filePath IN (");
		await index.addChunks(
			[
				...fileRows("src/gen/f0.ts", 1),
				...fileRows("src/gen/f299.ts", 1),
				...fileRows("src/keep.ts", 1, 3),
			],
			REPO1,
		);
		const results = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 10 },
			{
				...emptyOverlayCandidates(),
				suppressedPaths: many,
			},
		);
		expect(results.map((r) => rel(r.chunk.filePath))).toEqual(["src/keep.ts"]);
		expect(await index.countRowsForStoredPaths(B1, many)).toBe(2);
	});
});

describe("OBS-1 — observations survive the suppression of the file they name", () => {
	test("an observation whose affectedFiles[0] is a SERVED path stays visible (A)", async () => {
		await index.addChunks(fileRows("src/watched.ts", 2), REPO1);
		await index.addDocuments(
			[
				doc({
					id: hexId("obs-watched"),
					content:
						"observation: marmotword parsing in watched breaks on empty input",
					documentType: "session_observation",
					filePath: "src/watched.ts",
					fileHash: "",
					sourceIds: [],
					metadata: {
						observationType: "gotcha",
						affectedFiles: ["src/watched.ts"],
					},
					vector: vec(1.5),
				}),
			],
			{ pathKind: "synthetic", branchId: BRANCH_ID_SHARED },
		);
		const edited = chunk({
			path: "src/watched.ts",
			label: "w-ed",
			near: 2,
			name: "watchedEdited",
			content: "function watchedEdited() { return marmotword; }",
		});
		const overlay = await overlayCandidatesFrom({
			overlayStore,
			queryVector: vec(1),
			served: [{ path: "src/watched.ts", chunks: [edited] }],
		});
		const results = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 10 },
			overlay,
		);
		const obs = results.filter((r) => r.documentType === "session_observation");
		expect(obs.map((r) => r.chunk.id)).toEqual([hexId("obs-watched")]);
		// …and the stale code rows of that path are gone.
		expect(
			results.filter(
				(r) => r.source !== "dirty" && r.documentType !== "session_observation",
			),
		).toEqual([]);
		// The count reports code rows only: observations are not suppressed.
		expect(await index.countRowsForStoredPaths(B1, ["src/watched.ts"])).toBe(2);
	});
});

describe("SUM — summary rows of a suppressed file are suppressed with it", () => {
	test("a symbol_summary of a suppressed file attaches to nothing and takes no slot", async () => {
		const [stale] = fileRows("src/sum.ts", 1);
		await index.addChunks([stale, ...fileRows("src/other.ts", 1, 3)], REPO1);
		await index.addDocuments(
			[
				doc({
					id: hexId("sum-of-stale"),
					content: "summary: marmotword helper in sum",
					documentType: "symbol_summary",
					filePath: "src/sum.ts",
					sourceIds: [stale.id],
					vector: vec(1.2),
				}),
			],
			REPO1,
		);
		const results = await index.search(
			"marmotword",
			vec(1),
			B1,
			{ limit: 10 },
			{
				...emptyOverlayCandidates(),
				suppressedPaths: ["src/sum.ts"],
			},
		);
		expect(results.map((r) => rel(r.chunk.filePath))).toEqual(["src/other.ts"]);
		expect(results[0].summary).toBeUndefined();
		expect(await index.countRowsForStoredPaths(B1, ["src/sum.ts"])).toBe(2);
	});
});
