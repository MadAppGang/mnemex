/**
 * Step 3 black-box — R3 cost, cache, retention and concurrency
 * (test-plan TEST-34..39). Every embed count is taken from the fake provider's
 * journal (the wire); the binary's own counters are only cross-checked.
 */
import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { billingWithQuokka, TELEMETRY } from "./fixtures";
import {
	assertNoSecuritySpawn,
	assertSearchContract,
	createSandbox,
	duBytes,
	filesUnder,
	fillerFiles,
	findDirs,
	fn,
	fSmall,
	git,
	indexRepo,
	lineOf,
	makeRepo,
	median,
	num,
	overlayTexts,
	parseAgent,
	resultLines,
	rowsCovering,
	type Sandbox,
	search,
	startMnemex,
	writeFiles,
} from "./harness";

const LEDGER_FNS = [
	"ledgerAccrualAlpha",
	"ledgerAccrualBravo",
	"ledgerAccrualCharlie",
	"ledgerAccrualDelta",
	"ledgerAccrualEcho",
	"ledgerAccrualFoxtrot",
	"ledgerAccrualGolf",
	"ledgerAccrualHotel",
	"ledgerAccrualIndia",
	"ledgerAccrualJuliet",
];

/** src/ledger.ts with 10 functions; `edited` indices get a different body constant. */
function ledger(edited: Set<number>): string {
	return LEDGER_FNS.map((name, i) =>
		fn(
			name,
			`const ${name}Posting = value * ${edited.has(i) ? 100 + i : i + 2};\nreturn ${name}Posting;`,
		),
	).join("\n");
}

async function withRepo(
	files: Record<string, string>,
	fnBody: (sb: Sandbox, repo: string) => Promise<void>,
): Promise<void> {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "repo", files);
		await indexRepo(sb, repo);
		await fnBody(sb, repo);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

test("TEST-34: per-edit cost ≈ changed chunks, and a repeat search embeds nothing (NFR-1a)", async () => {
	await withRepo(
		{ ...fSmall(), "src/ledger.ts": ledger(new Set()) },
		async (sb, repo) => {
			const edited = new Set([0]);
			writeFileSync(join(repo, "src/ledger.ts"), ledger(edited));
			writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
			const first = await search(sb, repo, "ledger accrual posting");
			expect(num(first.out, "overlay_files")).toBe(2);

			const deltas: number[] = [];
			for (const k of [3, 5, 7]) {
				edited.add(k);
				writeFileSync(join(repo, "src/ledger.ts"), ledger(edited));
				const afterEdit = await search(sb, repo, "ledger accrual posting");
				const texts = afterEdit.overlayTexts;
				const name = LEDGER_FNS[k] as string;
				expect({ k, n: texts.length >= 1 && texts.length <= 2 }).toEqual({
					k,
					n: true,
				});
				expect(texts.some((t) => t.includes(name))).toBe(true);
				expect(texts.filter((t) => t.includes("wombat"))).toEqual([]);
				expect(num(afterEdit.out, "overlay_rebuilt")).toBe(1);
				expect(num(afterEdit.out, "overlay_embedded")).toBe(texts.length);

				const repeat = await search(sb, repo, "ledger accrual posting");
				expect({ k, texts: repeat.overlayTexts }).toEqual({ k, texts: [] });
				expect(num(repeat.out, "overlay_rebuilt")).toBe(0);
				deltas.push(afterEdit.res.ms - repeat.res.ms);
			}
			const load = (await import("node:os")).loadavg()[0];
			console.log(
				`TEST-34 edit-search minus repeat-search ms: ${deltas.map((d) => d.toFixed(0)).join(",")} load=${load?.toFixed(2)}`,
			);
			expect(median(deltas)).toBeLessThan(1000);
		},
	);
}, 240_000);

test("TEST-35: the first overlay pass of an edited file reuses the index's cached vectors", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		writeFileSync(
			join(repo, "src/billing.ts"),
			fSmall()["src/billing.ts"].replace(
				"invoiceTotal += item;",
				"invoiceTotal += item * 2;",
			),
		);
		const s = await search(sb, repo, "compute invoice total");
		expect(s.overlayTexts.length).toBe(1);
		expect(s.overlayTexts[0]).toContain("computeInvoiceTotal");
		expect(num(s.out, "overlay_cache_hits")).toBeGreaterThanOrEqual(2);

		const dirs = findDirs(repo, "dirty-overlay");
		expect(dirs.length).toBe(1);
		rmSync(dirs[0] as string, { recursive: true, force: true });
		const again = await search(sb, repo, "compute invoice total");
		expect(again.overlayTexts).toEqual([]);
		expect(resultLines(again.out)).toEqual(resultLines(s.out));
	});
}, 180_000);

test("TEST-36: cold first build of ~500 changed chunks within 10 s (NFR-1b, mnemex overhead)", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		writeFiles(repo, fillerFiles("Bk", 50));
		const s = await search(sb, repo, "compute invoice total");
		const load = (await import("node:os")).loadavg()[0];
		console.log(
			`TEST-36 wall=${s.res.ms.toFixed(0)}ms overlay_rebuild_ms=${s.out.header.get("overlay_rebuild_ms")} texts=${s.overlayTexts.length} load=${load?.toFixed(2)}`,
		);
		expect(s.res.ms).toBeLessThanOrEqual(10_000);
		expect(num(s.out, "overlay_files")).toBe(50);
		expect(num(s.out, "overlay_files_pending")).toBe(0);
		expect(num(s.out, "overlay_files_failed")).toBe(0);
		expect(new Set(s.overlayTexts).size).toBe(s.overlayTexts.length);
		expect(s.overlayTexts.length).toBeGreaterThanOrEqual(500);
		expect(num(s.out, "overlay_embedded")).toBe(s.overlayTexts.length);
	});
}, 180_000);

test("TEST-37: the overlay store does not accumulate versions across 20 edits (R3.10)", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		let du2 = 0;
		let dir = "";
		for (let i = 1; i <= 20; i++) {
			writeFileSync(
				billing,
				billingWithQuokka().replace("ledger * 2", `ledger * ${i + 2}`),
			);
			const s = await search(sb, repo, "quokka ledger reconcile");
			expect(num(s.out, "overlay_rebuilt")).toBe(1);
			if (i === 2) {
				dir = findDirs(repo, "dirty-overlay")[0] as string;
				du2 = duBytes(dir);
			}
		}
		const manifests = filesUnder(dir).filter((p) => p.endsWith(".manifest"));
		const du20 = duBytes(dir);
		console.log(
			`TEST-37 manifests=${manifests.length} du2=${du2} du20=${du20}`,
		);
		expect(manifests.length).toBeLessThanOrEqual(2);
		expect(du20).toBeLessThanOrEqual(2 * du2);
		const at = lineOf(billing, "quokkaLedgerReconcile");
		const last = await search(sb, repo, "quokka ledger reconcile");
		expect(rowsCovering(last.out.rows, billing, at).some((r) => r.dirty)).toBe(
			true,
		);
	});
}, 300_000);

test("TEST-38: two concurrent searches do not double-embed (R3.12)", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		writeFiles(repo, fillerFiles("Cc", 5, 3));
		sb.embedder.latencyMs = 50;
		sb.embedder.reset();
		const q = "compute invoice total";
		const args = [
			"--agent",
			"search",
			q,
			"-p",
			repo,
			"--no-reindex",
			"--limit",
			"10",
		];
		const a = startMnemex(sb, args, { cwd: repo });
		const b = startMnemex(sb, args, { cwd: repo });
		const [ra, rb] = await Promise.all([a.done, b.done]);
		const texts = overlayTexts(sb.embedder.journal, q);
		const outs = [ra, rb].map((r) => {
			expect(r.code).toBe(0);
			const out = parseAgent(r.stdout);
			assertSearchContract(out);
			expect(out.rows.length).toBeGreaterThan(0);
			const state = `${out.header.get("overlay")}/${out.header.get("overlay_reason")}`;
			expect(["on/dirty", "skipped/busy"]).toContain(state);
			return out;
		});
		console.log(
			`TEST-38 overlay texts=${texts.length} unique=${new Set(texts).size}`,
		);
		expect(texts.length).toBeGreaterThan(0);
		expect(new Set(texts).size).toBe(texts.length);
		expect(Math.max(...outs.map((o) => num(o, "overlay_files")))).toBe(5);
	});
}, 180_000);

test("TEST-39: a dirty search does not block an indexer running in another worktree", async () => {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "main", fSmall());
		await indexRepo(sb, repo);
		const wtB = join(sb.repos, "wtB");
		const wtC = join(sb.repos, "wtC");
		git(sb, repo, "worktree", "add", "-q", "-b", "feature-b", wtB);
		git(sb, repo, "worktree", "add", "-q", "-b", "feature-c", wtC);
		writeFiles(wtB, fillerFiles("Wb", 30));
		writeFiles(wtC, fillerFiles("Wc", 30));
		git(sb, wtB, "add", "-A");
		git(sb, wtB, "commit", "-q", "-m", "b");
		git(sb, wtC, "add", "-A");
		git(sb, wtC, "commit", "-q", "-m", "c");
		sb.embedder.latencyMs = 5;

		// solo baseline on C (cold cache of its own)
		const solo = await indexRepo(sb, wtC, [], {
			env: { MNEMEX_EMBED_CACHE_PATH: join(sb.root, "ec-c.db") },
		});
		const tc = solo.res.ms;

		// concurrent: index B (cold cache) while A runs a dirty search
		sb.embedder.reset();
		const idx = startMnemex(sb, ["--agent", "index", wtB, "--no-llm"], {
			cwd: wtB,
			env: { MNEMEX_EMBED_CACHE_PATH: join(sb.root, "ec-b.db") },
			timeoutMs: 180_000,
		});
		const deadline = Date.now() + 30_000;
		while (sb.embedder.journal.length < 30 && Date.now() < deadline)
			await Bun.sleep(25);
		writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
		const searchStarted = performance.now();
		const sr = startMnemex(
			sb,
			[
				"--agent",
				"search",
				"wombat telemetry flush",
				"-p",
				repo,
				"--no-reindex",
			],
			{
				cwd: repo,
			},
		);
		const [ri, rs] = await Promise.all([idx.done, sr.done]);
		const searchEnded = searchStarted + rs.ms;
		const indexEnded = idx.startedAt + ri.ms;
		console.log(
			`TEST-39 solo=${tc.toFixed(0)}ms concurrent=${ri.ms.toFixed(0)}ms search=${rs.ms.toFixed(0)}ms`,
		);
		expect(ri.code).toBe(0);
		expect(rs.code).toBe(0);
		const out = parseAgent(rs.stdout);
		assertSearchContract(out);
		expect(out.rows[0]?.file).toBe(join(repo, "src/telemetry.ts"));
		expect(out.rows[0]?.dirty).toBe(true);
		expect(searchEnded).toBeLessThan(indexEnded);
		expect(ri.ms).toBeLessThanOrEqual(tc + 2000);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 300_000);
