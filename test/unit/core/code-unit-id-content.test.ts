/**
 * Phase 3b-2b — decision I-14: THE CODE-UNIT ID CARRIES CONTENT.
 *
 * Before this, `code-unit-extractor.ts` hashed `filePath:unitType:name:startRow`
 * and no content, so two branches holding different bodies for one function at
 * one start line collapsed into ONE stored row and the branch that indexed LAST
 * decided what every branch saw — a V3.3 violation. The end-to-end falsifier is
 * the INVERTED assertion in `branch-write-path.test.ts`; this suite holds the
 * three things that test cannot say.
 *
 *   1. THE TWO KEYS, at the extractor. A row id moves with the content; the
 *      PARENT LINK does not move at all. Both directions are asserted, because
 *      a scheme that put content in both would pass half of this.
 *   2. THE CHURN PRICE, measured with an external per-ITEM embed counter. I-14
 *      argues the cost is near zero because `startRow` is already in the id, and
 *      names the one case it newly churns — content changed while name and start
 *      row did not — as "precisely the ambiguous case that must churn". This
 *      drives exactly that case and prices it.
 *   3. THE VERSION BUMP is a REBUILD TRIGGER, proven on a store stamped 4
 *      rather than by reading `oldStore.recordedVersion < CURRENT_INDEX_VERSION`.
 *
 * Every child here is `runIndexChild` / `runCli`, whose env comes from
 * `keychainSafeChildEnv()` with HOME, MNEMEX_EMBED_CACHE_PATH and
 * MNEMEX_GLOBAL_LOCK_PATH inside the test's own scratch (CLAUDE.md #24, #31).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	codeUnitParentKeyOf,
	createCodeUnitExtractor,
} from "../../../src/core/ast/code-unit-extractor.js";
import { CURRENT_INDEX_VERSION } from "../../../src/core/index-version.js";
import type { CodeUnit } from "../../../src/types.js";
import { startFakeOllamaEmbedServer } from "../../helpers/fake-ollama-embed-server.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	runIndexChild,
	sandboxHome,
	storeRows,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

/** One class, two methods, one nested function — every depth this tree has. */
function source(bump: string): string {
	return `export class Widget {
\tprivate n = 0;

\tbump(x: number): number {
\t\t${bump}
\t}

\treset(): void {
\t\tthis.n = 0;
\t}
}

export function helper(y: number): number {
\tfunction inner(z: number): number {
\t\treturn z * 2;
\t}
\treturn inner(y) + 1;
}

export function untouched(q: number): number {
\treturn q - 7;
}
`;
}

async function extract(text: string): Promise<CodeUnit[]> {
	return createCodeUnitExtractor().extractUnits(
		text,
		"src/w.ts",
		"typescript",
		createHash("sha256").update(text).digest("hex"),
	);
}

const label = (u: CodeUnit) =>
	`${u.unitType}:${u.name ?? "anon"}@${u.startLine}`;

// ════════════════════════════════════════════════════════════════════════════
// 1. The two keys
// ════════════════════════════════════════════════════════════════════════════

describe("I-14: the row id carries content, the parent link does not", () => {
	test("an in-place body edit moves the ids it must and NO parent link", async () => {
		const before = await extract(source("return x + 1;"));
		const after = await extract(source("return x + 9;"));

		const beforeByLabel = new Map(before.map((u) => [label(u), u]));
		const movedIds: string[] = [];
		const movedLinks: string[] = [];
		for (const u of after) {
			const prev = beforeByLabel.get(label(u));
			if (prev === undefined) continue;
			if (prev.id !== u.id) movedIds.push(label(u));
			if (prev.parentId !== u.parentId) movedLinks.push(label(u));
		}

		// THE IDS THAT MOVE ARE EXACTLY THE UNITS WHOSE TEXT CHANGED: the method
		// edited, the class that encloses it, and the file. `reset`, `helper`,
		// `inner` and `untouched` are byte-identical, so their rows are reused.
		// Under the OLD scheme this list was `["file:w.ts@1"]` — the method's own
		// id did not move even though its body did, which is the collision.
		expect(movedIds.sort()).toEqual([
			"class:Widget@1",
			"file:w.ts@1",
			"method:bump@4",
		]);
		// AND NOT ONE PARENT LINK MOVED. Under a scheme where the link is the
		// parent's row id this is 5 of 7 — including `reset`, whose own row is
		// never rewritten, so its link would be left naming a row that the narrow
		// step had already deleted.
		expect(movedLinks).toEqual([]);

		// No id of the old revision names a DIFFERENT body in the new one, which
		// is the property V3.3 rests on. It was 2 of 7 before this change.
		const bodyById = new Map(before.map((u) => [u.id, u.content]));
		const collided = after.filter((u) => {
			const prior = bodyById.get(u.id);
			return prior !== undefined && prior !== u.content;
		});
		expect(collided.map(label)).toEqual([]);
	});

	test("every parent link names a unit the SAME extraction produced", async () => {
		const units = await extract(source("return x + 1;"));
		const keys = new Set(units.map(codeUnitParentKeyOf));
		// The invariant that replaces "parentId is a row id": a link resolves in
		// the PARENT-KEY namespace. Falsified by linking to `parent.id` instead —
		// every non-null link then dangles, because a row id carries content.
		expect(
			units
				.filter((u) => u.parentId !== null && !keys.has(u.parentId))
				.map(label),
		).toEqual([]);
		// Non-vacuous: there really are links to check.
		expect(units.filter((u) => u.parentId !== null).length).toBeGreaterThan(4);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The churn price — the objection I-14 answers, measured
// ════════════════════════════════════════════════════════════════════════════

describe("the churn cost of content in the id", () => {
	test(
		"an in-place body edit embeds exactly the texts the store never held",
		async () => {
			const sb = createGitSandbox("unit-id-churn-");
			const server = startFakeOllamaEmbedServer();
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(
					join(project, "mnemex.json"),
					JSON.stringify({ enrichment: false }),
				);
				for (let i = 0; i < 4; i++) {
					mkdirSync(join(project, "src"), { recursive: true });
					writeFileSync(
						join(project, "src", `f${i}.ts`),
						source(`return x + ${i};`),
					);
				}
				const scratch = join(sb.root, "scratch");
				const home = sandboxHome(scratch);
				mkdirSync(join(home, ".mnemex"), { recursive: true });
				writeFileSync(
					join(home, ".mnemex", "config.json"),
					JSON.stringify({
						embeddingProvider: "ollama",
						ollamaEndpoint: server.url,
						defaultModel: "ollama/fake-embed",
					}),
				);
				// The machine-global cache OFF, so the only reuse measured is the
				// store's own (CLAUDE.md #31).
				const extra = {
					MNEMEX_MODEL: "ollama/fake-embed",
					MNEMEX_DISABLE_EMBED_CACHE: "1",
				};
				const vectors = join(project, ".mnemex", "vectors");

				const first = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
					extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const coldItems = server.embedInputs();
				const rowsBefore = await storeRows(vectors);

				// THE SHAPE I-14 NAMES: content changes, name and start row do not.
				// Not one line moves, so `startRow` cannot absorb this — it is the
				// case the content hash newly churns, and the one that must.
				server.resetCounts();
				for (let i = 0; i < 4; i++) {
					writeFileSync(
						join(project, "src", `f${i}.ts`),
						source(`return x + ${i + 100};`),
					);
				}

				const second = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
					extra,
				);
				expect(second.exitCode, second.stderr).toBe(0);
				const warmItems = server.embedInputs();
				const rowsAfter = await storeRows(vectors);

				const idsBefore = new Set(rowsBefore.map((r) => String(r.id)));
				const moved = rowsAfter.filter((r) => !idsBefore.has(String(r.id)));
				const textsBefore = new Set(
					rowsBefore.map((r) => `${r.documentType} ${r.content}`),
				);
				const newTexts = rowsAfter.filter(
					(r) => !textsBefore.has(`${r.documentType} ${r.content}`),
				);
				const newUnitTexts = newTexts.filter(
					(r) => r.documentType === "code_unit",
				).length;
				const units = (rows: Array<Record<string, unknown>>) =>
					rows.filter((r) => r.documentType === "code_unit").length;

				console.log(
					`in-place body edit: coldEmbedItems=${coldItems} warmEmbedItems=${warmItems} ` +
						`idsChanged=${moved.length}/${rowsAfter.length} ` +
						`textsChanged=${newTexts.length} (code_unit ${newUnitTexts}) ` +
						`unitsBefore=${units(rowsBefore)} unitsAfter=${units(rowsAfter)} ` +
						`rowsBefore=${rowsBefore.length} rowsAfter=${rowsAfter.length}`,
				);

				// THE PRICE, DERIVED FROM THE DATA rather than hardcoded: a text the
				// store has never held has to reach the provider, and nothing else
				// does. Putting content in the id changes WHICH ROW holds a body; it
				// does not change which bodies must be embedded.
				expect(warmItems).toBe(newTexts.length);
				// No id survives with a different body — the whole point.
				expect(
					rowsAfter
						.filter(
							(r) =>
								idsBefore.has(String(r.id)) &&
								!textsBefore.has(`${r.documentType} ${r.content}`),
						)
						.map((r) => String(r.id)),
				).toEqual([]);
				// And the store does not GROW: the superseded ids are narrowed away
				// in the same run, so a changed unit costs a row swap, not a row.
				expect(units(rowsAfter)).toBe(units(rowsBefore));
				expect(rowsAfter.length).toBe(rowsBefore.length);
			} finally {
				server.stop();
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. The version bump IS the rebuild trigger
// ════════════════════════════════════════════════════════════════════════════

describe("a store stamped with an older index version is rebuilt", () => {
	test(
		"a v4 stamp rebuilds under the bumped constant, and reports the version it came from",
		async () => {
			const sb = createGitSandbox("v5-rebuild-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				mkdirSync(join(project, "src"), { recursive: true });
				writeFileSync(join(project, "src", "w.ts"), source("return x + 1;"));
				const scratch = join(sb.root, "scratch");
				const storeJson = join(project, ".mnemex", "store.json");

				// A CURRENT store, written by the real indexer.
				const first = await runIndexChild("index", project, scratch, sb.root);
				expect(first.exitCode, first.stderr).toBe(0);
				expect(first.result?.upgradedFromIndexVersion).toBeNull();
				expect(JSON.parse(readFileSync(storeJson, "utf8")).indexVersion).toBe(
					CURRENT_INDEX_VERSION,
				);

				// Roll ONLY the stamp back to 4 — the shape probes
				// (`hasBranchIdsColumn`, `trackerNeedsV4Schema`) both still say the
				// store is current, so the version comparison is the only thing that
				// can fire. That is what makes this a test of the bump and not of
				// the v3 detection beside it.
				const meta = JSON.parse(readFileSync(storeJson, "utf8"));
				writeFileSync(storeJson, JSON.stringify({ ...meta, indexVersion: 4 }));

				const second = await runIndexChild("index", project, scratch, sb.root);
				expect(second.exitCode, second.stderr).toBe(0);
				// Reported in DATA: two of the four entry points pass no onProgress.
				// Without the bump `4 < CURRENT_INDEX_VERSION` is false, this field
				// is absent and the v4 ids would be left in the store as orphans.
				expect(second.result?.upgradedFromIndexVersion).toBe(4);
				expect(JSON.parse(readFileSync(storeJson, "utf8")).indexVersion).toBe(
					CURRENT_INDEX_VERSION,
				);

				// The rebuild really happened: every row was re-written by this run,
				// and the store is whole rather than doubled.
				const rows = await storeRows(join(project, ".mnemex", "vectors"));
				expect(rows.length).toBeGreaterThan(0);
				expect(rows.every((r) => String(r.branchIds) !== "")).toBe(true);

				// A third run has nothing to upgrade.
				const third = await runIndexChild("index", project, scratch, sb.root);
				expect(third.exitCode, third.stderr).toBe(0);
				expect(third.result?.upgradedFromIndexVersion).toBeNull();
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. The sweep — the compiler cannot tell the two keys apart
// ════════════════════════════════════════════════════════════════════════════

/**
 * CLAUDE.md #32's rule, applied to a NAMESPACE instead of a parameter list.
 *
 * `id` and `parentId` are both `string`, so `getChildUnits(scope, unit.id)`
 * compiles, typechecks, returns `[]` and says nothing. That is the same shape
 * as the `BranchScopedGraph` defect: the type system pins the ARGUMENT and
 * never the USE, and a green suite in between proves nothing. What holds the
 * line is a sweep over the SOURCE.
 *
 * It reads `src/**` and executes none of it, and it is scoped to `src/` on
 * purpose — `test/integration/code-unit-extractor.test.ts` calls
 * `getChildren(units, classUnit.id)` deliberately, as the control proving that
 * the mistake returns nothing.
 */
const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** Comment-stripped, so the prose beside a join is not a false positive. */
function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function typescriptFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...typescriptFiles(full));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
			out.push(full);
	}
	return out;
}

/** A link compared against a ROW ID, in either order. */
const LINK_VS_ID = [
	/\.parentId\s*[!=]==\s*[A-Za-z_$][\w$.]*\.id\b/,
	/[A-Za-z_$][\w$.]*\.id\s*[!=]==\s*[A-Za-z_$][\w$.]*\.parentId\b/,
];
/** A child lookup handed a ROW ID. */
const CHILD_LOOKUP_BY_ID =
	/\b(?:getChildUnits|getChildren|getUnitChildren)\s*\([^()]*\.id\s*[,)]/;

function offenders(text: string): string[] {
	const found: string[] = [];
	for (const line of withoutComments(text).split("\n")) {
		if (LINK_VS_ID.some((re) => re.test(line)) || CHILD_LOOKUP_BY_ID.test(line))
			found.push(line.trim());
	}
	return found;
}

/**
 * THE SYMBOL GRAPH IS A DIFFERENT NAMESPACE, and its join is correct.
 *
 * `SymbolDefinition.parentId` (`symbol-extractor.ts`, `createSymbolId(filePath,
 * name, kind, startLine)`) really is another symbol's id, there is no second
 * key, and nothing in I-14 touches it. A regex cannot tell a `CodeUnit` from a
 * `SymbolDefinition`, so the exemption is named here with its reason rather
 * than by widening the pattern until it catches nothing.
 *
 * Each entry is re-checked below: an allowlisted file that no longer matches
 * has to leave, or the list becomes a place for real defects to hide.
 */
const SYMBOL_GRAPH_ALLOWLIST: ReadonlyArray<[string, string]> = [
	[
		"core/reference-graph.ts",
		"SymbolDefinition.parentId IS a symbol id (symbol-extractor.ts); the symbol graph has one key, not two",
	],
];

describe("no source in src/ joins a parent link against a row id", () => {
	test("the sweep finds nothing outside the symbol graph", () => {
		const exempt = new Set(SYMBOL_GRAPH_ALLOWLIST.map(([file]) => file));
		const hits: string[] = [];
		for (const file of typescriptFiles(SRC_ROOT)) {
			const rel = relative(SRC_ROOT, file);
			if (exempt.has(rel)) continue;
			for (const line of offenders(readFileSync(file, "utf8"))) {
				hits.push(`${rel}: ${line}`);
			}
		}
		expect(hits).toEqual([]);
	});

	test("every allowlist entry still earns its place", () => {
		for (const [rel] of SYMBOL_GRAPH_ALLOWLIST) {
			const text = readFileSync(join(SRC_ROOT, rel), "utf8");
			expect(offenders(text).length).toBeGreaterThan(0);
		}
	});

	test("the sweep is NOT vacuous: each shape it forbids is caught", () => {
		// The three ways this was written in this tree BEFORE I-14 split the
		// namespaces. Each was correct then and is a silent defect now.
		const wasSummarizer = "const c = all.filter(u => u.parentId === unit.id);";
		const wasGetParent = "return units.find(u => u.id === child.parentId);";
		const wasRetriever = "await store.getChildUnits(scope, parent.id);";
		expect(offenders(wasSummarizer)).toEqual([wasSummarizer]);
		expect(offenders(wasGetParent)).toEqual([wasGetParent]);
		expect(offenders(wasRetriever)).toEqual([wasRetriever]);
		// …and the CORRECT forms are not flagged.
		expect(
			offenders("const c = all.filter(u => u.parentId === parentKey);"),
		).toEqual([]);
		expect(
			offenders("await store.getChildUnits(scope, codeUnitParentKeyOf(p));"),
		).toEqual([]);
		// A comment holding the forbidden shape is prose, not code.
		expect(offenders("// never write u.parentId === unit.id here")).toEqual([]);
	});
});
