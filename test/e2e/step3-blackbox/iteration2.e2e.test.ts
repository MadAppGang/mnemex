/**
 * Step 3 black-box — outer-loop iteration 2 regressions (test-plan TEST-53..55).
 * Both failures were found by the real-Ollama rig (validation/feedback-iteration-1.md)
 * while the rest of this suite was green.
 *
 *  F1 (R1.1, NFR-4): a result whose `name=` is a LABEL of a symbol — `X (part k/n)`,
 *      `X (fields)` — must be judged as the symbol `X` in its own file.
 *  F2 (R3.2): an UNCHANGED chunk of a dirty file must rank exactly where its clean
 *      index copy ranks at the SAME --limit (channel depth scales with the limit).
 *
 * Label shapes were confirmed on the built binary before asserting (see fixtures.ts).
 * Each test was also run against a pre-fix build of the iteration-1 tree
 * (`S3BB_DIST=<clone>/dist/index.js`) to show it can fail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { depthFixture, dockFile, labelsFixture } from "./fixtures";
import {
	assertNoSecuritySpawn,
	createSandbox,
	indexRepo,
	makeRepo,
	num,
	type Row,
	runMnemex,
	type Sandbox,
	search,
} from "./harness";

const PART = (name: string) => new RegExp(`^${name} \\(part \\d+/\\d+\\)$`);
const FIELDS = (name: string) => new RegExp(`^${name} \\(fields\\)$`);

describe("F1 — label-named results are judged as their symbol (shared read-only fixture)", () => {
	let sb: Sandbox;
	let repo: string;
	let deadCode = "";

	beforeAll(async () => {
		sb = createSandbox();
		repo = makeRepo(sb, "labels", labelsFixture());
		await indexRepo(sb, repo);
		const dc = await runMnemex(
			sb,
			["--agent", "dead-code", "-p", repo, "--include-exported", "-n", "5000"],
			{
				cwd: repo,
			},
		);
		deadCode = dc.stdout;
	}, 300_000);

	afterAll(() => {
		assertNoSecuritySpawn(sb);
		sb.cleanup();
	});

	const rowsNamed = (rows: Row[], file: string, re: RegExp) =>
		rows.filter((r) => r.file === file && re.test(r.name) && !r.dirty);

	test("TEST-53: a dead function shown as `name (part k/n)` is penalised; the live one is not", async () => {
		// the product's own verdict: deadMegaRoutine is dead, liveMegaRoutine is not
		const dead = deadCode
			.split("\n")
			.filter((l) => l.startsWith("dead_symbol "));
		expect(dead.some((l) => l.includes("name=deadMegaRoutine "))).toBe(true);
		expect(dead.some((l) => l.includes("name=liveMegaRoutine "))).toBe(false);

		const d = await search(sb, repo, "dead mega routine step", { limit: 15 });
		const deadParts = rowsNamed(
			d.out.rows,
			join(repo, "src/dead-routine.ts"),
			PART("deadMegaRoutine"),
		);
		expect(deadParts.length).toBeGreaterThanOrEqual(2); // label shape present (precondition)
		for (const r of deadParts)
			expect({ row: r.name, dead: r.dead }).toEqual({
				row: r.name,
				dead: true,
			});

		const l = await search(sb, repo, "live mega routine step", { limit: 15 });
		const liveParts = rowsNamed(
			l.out.rows,
			join(repo, "src/live-routine.ts"),
			PART("liveMegaRoutine"),
		);
		expect(liveParts.length).toBeGreaterThanOrEqual(2);
		for (const r of liveParts)
			expect({ row: r.name, dead: r.dead }).toEqual({
				row: r.name,
				dead: false,
			});
	}, 180_000);

	test("TEST-54: an unreferenced interface shown as `Name (fields)` is penalised; a referenced one is not", async () => {
		const d = await search(sb, repo, "dead doc value record", { limit: 10 });
		const deadRow = rowsNamed(
			d.out.rows,
			join(repo, "src/dead-doc.ts"),
			FIELDS("DeadDocShape"),
		);
		expect(deadRow.length).toBe(1); // label shape present (precondition)

		const l = await search(sb, repo, "live doc value record", { limit: 10 });
		const liveRow = rowsNamed(
			l.out.rows,
			join(repo, "src/live-doc.ts"),
			FIELDS("LiveDocShape"),
		);
		expect(liveRow.length).toBe(1);

		// evidence for the failure analysis: what the graph says about the two interfaces
		const callers = await runMnemex(
			sb,
			["--agent", "callers", "DeadDocShape", "-p", repo],
			{ cwd: repo },
		);
		console.log(
			`TEST-54 graph: dead-code lists DeadDocShape=${deadCode.includes("name=DeadDocShape ")}; callers DeadDocShape → ${callers.stdout
				.split("\n")
				.filter((x) => x.startsWith("caller"))
				.join(" ; ")}; penalty_same_file=${num(d.out, "penalty_same_file")}`,
		);

		expect({ row: liveRow[0]?.name, dead: liveRow[0]?.dead }).toEqual({
			row: "LiveDocShape (fields)",
			dead: false,
		});
		expect({ row: deadRow[0]?.name, dead: deadRow[0]?.dead }).toEqual({
			row: "DeadDocShape (fields)",
			dead: true,
		});
	}, 180_000);
});

test("TEST-55: an unchanged chunk of a dirty file ranks where its index copy ranks, at the same --limit", async () => {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "depth", depthFixture());
		await indexRepo(sb, repo);
		const dock = join(repo, "src/dock.ts");
		const q = "harbor beacon";

		// precondition: dock.ts's index copies are distant (outside the top 20)
		const deep = await search(sb, repo, q, {
			limit: 200,
			flags: ["--no-dirty"],
		});
		const dockRanks = deep.out.rows.flatMap((r, i) =>
			r.file === dock ? [i + 1] : [],
		);
		expect(dockRanks.length).toBeGreaterThan(0);
		expect(Math.min(...dockRanks)).toBeGreaterThan(20);

		// one chunk edited (last function); the other 9 are unchanged, cache-hit text
		writeFileSync(dock, dockFile(5));
		for (const limit of [5, 10, 20]) {
			const off = await search(sb, repo, q, { limit, flags: ["--no-dirty"] });
			const on = await search(sb, repo, q, { limit });
			expect([
				on.out.header.get("overlay"),
				num(on.out, "overlay_files"),
			]).toEqual(["on", 1]);
			const dockInTop = on.out.rows
				.filter((r) => r.file === dock)
				.map((r) => `${r.line}-${r.endLine}`);
			expect({ limit, dockInTop }).toEqual({ limit, dockInTop: [] });
			expect({ limit, spans: on.out.rows.map((r) => r.span) }).toEqual({
				limit,
				spans: off.out.rows.map((r) => r.span),
			});
		}
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 300_000);
