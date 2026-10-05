/**
 * Step 3 black-box — R1: the dead-code penalty judges the symbol in the
 * result's OWN file (test-plan TEST-01..04, TEST-27, TEST-50).
 *
 * Fixture design (observed through the built binary, not read from src/):
 * every symbol with no in-edges scores PageRank 1/N, and `dead-code`'s
 * threshold is 0.001, so the fixture carries ~1 600 filler functions to bring
 * an uncalled symbol under it. Live/dead namesakes are linked by IMPORT
 * (cross-file calls resolve; in-file calls to a duplicated name did not).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { penaltyFixture } from "./fixtures";
import {
	assertNoSecuritySpawn,
	createSandbox,
	duplicateSpans,
	fSmall,
	indexRepo,
	lineOf,
	makeRepo,
	num,
	type Row,
	rowsCovering,
	runMnemex,
	type Sandbox,
	search,
} from "./harness";

const named = (rows: Row[], file: string, name: string) =>
	rows.filter(
		(r) =>
			r.file === file && r.name === name && r.type === "function" && !r.dirty,
	);

describe("R1 — dead-code penalty, shared read-only fixture", () => {
	let sb: Sandbox;
	let repo: string;

	beforeAll(async () => {
		sb = createSandbox();
		repo = makeRepo(sb, "penalty", penaltyFixture());
		await indexRepo(sb, repo);
	}, 300_000);

	afterAll(() => {
		assertNoSecuritySpawn(sb);
		sb.cleanup();
	});

	test("TEST-01: live `get` is not penalised; the dead same-named `get` in another file is", async () => {
		const s = await search(sb, repo, "get shelf key", { limit: 40 });
		const live = named(s.out.rows, join(repo, "src/a-cache.ts"), "get");
		const dead = named(s.out.rows, join(repo, "src/z-cache.ts"), "get");
		expect(live.length).toBe(1);
		expect(dead.length).toBe(1);
		expect(live[0]?.dead).toBe(false);
		expect(dead[0]?.dead).toBe(true);
	}, 120_000);

	test("TEST-02: penalty direction holds in both file orders (wrong-file flip detector)", async () => {
		// arrangement 1: `get` live in a-cache (sorts first), dead in z-cache
		// arrangement 2: `fetchItem` live in z-store (sorts last), dead in a-store
		const s = await search(sb, repo, "fetch item sku stock retired", {
			limit: 40,
		});
		const live = named(s.out.rows, join(repo, "src/z-store.ts"), "fetchItem");
		const dead = named(s.out.rows, join(repo, "src/a-store.ts"), "fetchItem");
		expect(live.length).toBe(1);
		expect(dead.length).toBe(1);
		expect(live[0]?.dead).toBe(false);
		expect(dead[0]?.dead).toBe(true);
	}, 120_000);

	test("TEST-03: same-file match count is positive and bounds the penalty", async () => {
		for (const q of [
			"get shelf key",
			"fetch item sku",
			"compute invoice total",
			"read setting",
			"obsolete tariff matrix",
		]) {
			const s = await search(sb, repo, q, { limit: 20 });
			const namedFns = s.out.rows.filter(
				(r) => !r.dirty && r.type === "function" && r.name !== "",
			);
			expect(num(s.out, "penalty_same_file")).toBeGreaterThan(0);
			expect(num(s.out, "penalty_same_file")).toBeGreaterThanOrEqual(
				namedFns.length,
			);
			// rows ≤ applied ≤ same_file is asserted for every search by assertSearchContract
		}
	}, 180_000);

	test("TEST-04: graph commands print repo-relative paths; search prints absolute", async () => {
		const absSrc = `${repo}/src/`;
		const outputs: Record<string, string> = {};
		for (const args of [
			["symbol", "get"],
			["callers", "get"],
			["callees", "readAlphaSetting"],
			["context", "get"],
			["map"],
			["dead-code"],
			["test-gaps"],
			["impact", "get"],
		]) {
			const r = await runMnemex(sb, ["--agent", ...args, "-p", repo], {
				cwd: repo,
			});
			expect({ cmd: args.join(" "), code: r.code }).toEqual({
				cmd: args.join(" "),
				code: 0,
			});
			expect({
				cmd: args.join(" "),
				absolute: r.stdout.includes(absSrc),
			}).toEqual({
				cmd: args.join(" "),
				absolute: false,
			});
			outputs[args[0] as string] = r.stdout;
		}
		expect(outputs.symbol).toContain("file=src/");
		expect(outputs.callers).toContain("file=src/users/");
		// dead-code: the dead namesakes are listed, the live ones are not
		const dead = (outputs["dead-code"] ?? "")
			.split("\n")
			.filter((l) => l.startsWith("dead_symbol "));
		expect(
			dead.some(
				(l) => l.includes("name=get ") && l.includes("file=src/z-cache.ts"),
			),
		).toBe(true);
		expect(
			dead.some(
				(l) => l.includes("name=get ") && l.includes("file=src/a-cache.ts"),
			),
		).toBe(false);
		expect(
			dead.some(
				(l) =>
					l.includes("name=fetchItem ") && l.includes("file=src/a-store.ts"),
			),
		).toBe(true);
		expect(
			dead.some(
				(l) =>
					l.includes("name=fetchItem ") && l.includes("file=src/z-store.ts"),
			),
		).toBe(false);

		const s = await search(sb, repo, "get shelf key", { limit: 10 });
		expect(s.out.rows.length).toBeGreaterThan(0);
		for (const r of s.out.rows)
			expect(r.file.startsWith(`${repo}/`)).toBe(true);
	}, 180_000);
});

test("TEST-27: overlay rows never carry a penalty, and the gap is declared", async () => {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "penalty-dirty", penaltyFixture());
		await indexRepo(sb, repo);
		// control: served from the index, the dead z-cache `get` IS penalised
		const control = await search(sb, repo, "get shelf key", { limit: 40 });
		expect(
			named(control.out.rows, join(repo, "src/z-cache.ts"), "get")[0]?.dead,
		).toBe(true);

		// dirty: modify z-cache (dead `get` kept) and add an untracked file with an uncalled function
		writeFileSync(
			join(repo, "src/z-cache.ts"),
			[
				"const oldShelf: Record<string, string> = {};",
				"function get(key: string): string | undefined {",
				"  return oldShelf[key] ?? oldShelf.fallbackShelf;",
				"}",
				"export function oldShelfSize(): number {",
				"  return Object.keys(oldShelf).length;",
				"}",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(repo, "src/fresh.ts"),
			"function deadFreshKestrel(x: number): number {\n  return x * 13;\n}\n",
		);
		const gaps: string[] = [];
		for (const q of ["get shelf key fallback", "dead fresh kestrel"]) {
			const s = await search(sb, repo, q, { limit: 40 });
			expect(s.out.header.get("overlay")).toBe("on");
			expect(num(s.out, "overlay_files")).toBe(2);
			const dirty = s.out.rows.filter((r) => r.dirty);
			expect(dirty.length).toBeGreaterThan(0);
			for (const r of dirty) expect(r.dead).toBe(false);
			gaps.push(s.out.header.get("overlay_gaps") ?? "");
		}
		const zRows = (
			await search(sb, repo, "get shelf key fallback", { limit: 40 })
		).out.rows.filter((r) => r.file === join(repo, "src/z-cache.ts"));
		expect(zRows.length).toBeGreaterThan(0);
		for (const r of zRows) expect(r.dirty).toBe(true);
		assertNoSecuritySpawn(sb);
		// orchestrator ruling (phase 6 test planning, 2): the declared gap token
		for (const g of gaps) expect(g).toContain("no-code-units");
	} finally {
		sb.cleanup();
	}
}, 300_000);

test("TEST-50: absolute roll-up — each fix is RIGHT, not merely unchanged", async () => {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "rollup", penaltyFixture());
		await indexRepo(sb, repo);
		const numbers: Record<string, number | boolean> = {};

		const p = await search(sb, repo, "get shelf key", { limit: 40 });
		numbers.penalty_same_file = num(p.out, "penalty_same_file");
		numbers.live_get_unpenalised =
			named(p.out.rows, join(repo, "src/a-cache.ts"), "get")[0]?.dead === false;
		numbers.dead_get_penalised =
			named(p.out.rows, join(repo, "src/z-cache.ts"), "get")[0]?.dead === true;
		numbers.duplicate_spans = duplicateSpans(p.out.rows);

		// strong match on a LIVE symbol (5 callers) — dead targets are rightly demoted at this scale
		const strongQuery = "get key shelf store";
		const strong = await search(sb, repo, strongQuery, { limit: 10 });
		const top = strong.out.rows[0];
		numbers.strong_index_rank1 =
			top?.file === join(repo, "src/a-cache.ts") && top?.dirty === false;

		const billing = join(repo, "src/billing.ts");
		writeFileSync(
			billing,
			fSmall()
				["src/billing.ts"].replace(
					/export function legacyRefundPath[\s\S]*?\n}\n\n/,
					"",
				)
				.concat(
					"export function quokkaLedgerReconcile(ledger: number): number {\n  const quokkaLedger = ledger * 2;\n  return quokkaLedger;\n}\n",
				),
		);
		const planted = await search(sb, repo, "quokka ledger reconcile", {
			limit: 10,
		});
		const at = lineOf(billing, "quokkaLedgerReconcile");
		const hit = rowsCovering(planted.out.rows, billing, at).find(
			(r) => r.dirty,
		);
		numbers.planted_rank = hit ? planted.out.rows.indexOf(hit) + 1 : -1;
		const removed = await search(sb, repo, "legacy refund path", { limit: 10 });
		numbers.removed_fn_rows = removed.out.rows.filter(
			(r) => r.name === "legacyRefundPath",
		).length;
		// a strong INDEX match (clean file) is still rank 1 while the overlay is serving
		const strongDirty = await search(sb, repo, strongQuery, { limit: 10 });
		const topDirty = strongDirty.out.rows[0];
		numbers.strong_rank1_with_overlay =
			strongDirty.out.header.get("overlay") === "on" &&
			num(strongDirty.out, "overlay_files") === 1 &&
			topDirty?.file === top?.file &&
			topDirty?.line === top?.line &&
			topDirty?.dirty === false;

		console.log(`TEST-50 absolute numbers: ${JSON.stringify(numbers)}`);
		expect(numbers.penalty_same_file as number).toBeGreaterThan(0);
		expect(numbers.live_get_unpenalised).toBe(true);
		expect(numbers.dead_get_penalised).toBe(true);
		expect(numbers.duplicate_spans).toBe(0);
		expect(numbers.strong_index_rank1).toBe(true);
		expect(numbers.planted_rank as number).toBeGreaterThanOrEqual(1);
		expect(numbers.planted_rank as number).toBeLessThanOrEqual(10);
		expect(numbers.removed_fn_rows).toBe(0);
		expect(numbers.strong_rank1_with_overlay).toBe(true);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 300_000);
