/**
 * Step 3 black-box — R3 local dirty overlay, core behaviour
 * (test-plan TEST-11..18, TEST-21..24, TEST-28..30).
 *
 * Every search runs with `--no-reindex`, so "dirty" stays relative to the index
 * the test built. Embed counts are taken from the fake provider's journal.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	billingWithoutLegacy,
	billingWithQuokka,
	TELEMETRY,
	UNRELATED,
} from "./fixtures";
import {
	allTexts,
	assertNoSecuritySpawn,
	createSandbox,
	diffSnapshots,
	fSmall,
	git,
	indexRepo,
	lineOf,
	makeRepo,
	num,
	porcelain,
	rankOf,
	resultLines,
	rowsCovering,
	runMnemex,
	type Sandbox,
	search,
	snapshot,
	writeFiles,
	writeGlobalConfig,
} from "./harness";

async function withSmall(
	fn: (sb: Sandbox, repo: string) => Promise<void>,
	opts: { ignore?: string[]; files?: Record<string, string> } = {},
): Promise<void> {
	const sb = createSandbox();
	try {
		const repo = makeRepo(
			sb,
			"small",
			{ ...fSmall(), ...(opts.files ?? {}) },
			{ ignore: opts.ignore },
		);
		await indexRepo(sb, repo);
		await fn(sb, repo);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

const COUNT_KEYS = [
	"overlay_files",
	"overlay_files_index_current",
	"overlay_files_deleted",
	"overlay_files_pending",
	"overlay_files_failed",
	"overlay_files_unclassified",
	"overlay_rebuilt",
	"overlay_embedded",
	"overlay_cache_hits",
	"overlay_suppressed_rows",
];

const INDEX_QUERIES = [
	"compute invoice total",
	"obsolete tariff matrix",
	"estimate parcel transit",
	"format currency label",
	"courier zone lookup",
];

test("TEST-11: clean worktree is a no-op and ranks exactly like the index (NFR-2)", async () => {
	await withSmall(async (sb, repo) => {
		expect(porcelain(sb, repo)).toBe("");
		for (const q of INDEX_QUERIES) {
			const plain = await search(sb, repo, q, { limit: 10 });
			const off = await search(sb, repo, q, {
				limit: 10,
				flags: ["--no-dirty"],
			});
			// orchestrator ruling 1: ran, nothing stale
			expect(plain.out.header.get("overlay")).toBe("on");
			expect(plain.out.header.get("overlay_reason")).toBe("index-current");
			for (const k of COUNT_KEYS)
				expect({ k, v: num(plain.out, k) }).toEqual({ k, v: 0 });
			expect(plain.overlayTexts).toEqual([]);
			expect(plain.out.rows.some((r) => r.dirty)).toBe(false);
			expect(plain.out.rows.length).toBeGreaterThan(0);
			expect(resultLines(plain.out)).toEqual(resultLines(off.out));
			expect(off.out.header.get("overlay")).toBe("off");
		}
	});
}, 180_000);

test("TEST-12: a modified tracked file's new function is searchable without `mnemex index`", async () => {
	await withSmall(async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		writeFileSync(billing, billingWithQuokka());
		const s = await search(sb, repo, "quokka ledger reconcile", { limit: 10 });
		expect(s.out.header.get("overlay")).toBe("on");
		expect(num(s.out, "overlay_files")).toBe(1);
		expect(num(s.out, "overlay_suppressed_rows")).toBeGreaterThan(0);
		const at = lineOf(billing, "quokkaLedgerReconcile");
		const hit = rowsCovering(s.out.rows, billing, at).filter((r) => r.dirty);
		expect(hit.length).toBe(1);
		const rank = s.out.rows.indexOf(hit[0] as (typeof hit)[number]) + 1;
		console.log(`TEST-12 planted rank=${rank}`);
		expect(rank).toBeLessThanOrEqual(10);
		for (const r of s.out.rows.filter((x) => x.file === billing))
			expect(r.dirty).toBe(true);
		expect(
			s.overlayTexts.some((t) => t.includes("quokkaLedgerReconcile")),
		).toBe(true);
		// the index itself was not touched: without the overlay the original rows are there
		const off = await search(sb, repo, "legacy refund path", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		expect(
			off.out.rows.some(
				(r) => r.file === billing && r.name === "legacyRefundPath" && !r.dirty,
			),
		).toBe(true);
		expect(off.out.rows.some((r) => r.dirty)).toBe(false);
		// orchestrator ruling 2: the empty name= on dirty rows is a declared gap
		expect(s.out.header.get("overlay_gaps") ?? "").toContain("no-code-units");
	});
}, 180_000);

test("TEST-13: a function removed in the working tree no longer appears (positive suppression)", async () => {
	await withSmall(async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		const control = await search(sb, repo, "legacy refund path", { limit: 10 });
		expect(control.out.rows[0]?.name).toBe("legacyRefundPath");
		const controlBillingRows = control.out.rows.filter(
			(r) => r.file === billing,
		).length;
		expect(controlBillingRows).toBeGreaterThan(0);

		writeFileSync(billing, billingWithoutLegacy());
		const s = await search(sb, repo, "legacy refund path", { limit: 10 });
		expect(s.out.rows.filter((r) => r.name === "legacyRefundPath")).toEqual([]);
		expect(s.out.rows.filter((r) => r.file === billing && !r.dirty)).toEqual(
			[],
		);
		const suppressed = num(s.out, "overlay_suppressed_rows");
		expect(suppressed).toBeGreaterThan(0);
		expect(suppressed).toBeGreaterThanOrEqual(controlBillingRows);
	});
}, 180_000);

test("TEST-14: an untracked, not-ignored file is searchable", async () => {
	await withSmall(async (sb, repo) => {
		const tel = join(repo, "src/telemetry.ts");
		writeFileSync(tel, TELEMETRY);
		const s = await search(sb, repo, "wombat telemetry flush", { limit: 10 });
		expect(s.out.rows[0]?.file).toBe(tel);
		expect(s.out.rows[0]?.dirty).toBe(true);
		expect(num(s.out, "overlay_files")).toBe(1);
		expect(num(s.out, "overlay_suppressed_rows")).toBe(0);
	});
}, 180_000);

test("TEST-15: an ignored untracked file is never embedded or returned", async () => {
	await withSmall(
		async (sb, repo) => {
			mkdirSync(join(repo, "scratch"), { recursive: true });
			writeFileSync(
				join(repo, "scratch/secret.ts"),
				"export function ignoredPangolinFn(x: number): number {\n  return x + 1;\n}\n",
			);
			writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
			const s = await search(sb, repo, "ignored pangolin fn", { limit: 20 });
			expect(
				allTexts(s.journal).filter((t) => t.includes("ignoredPangolinFn")),
			).toEqual([]);
			expect(s.out.rows.filter((r) => r.file.includes("/scratch/"))).toEqual(
				[],
			);
			expect(num(s.out, "overlay_files")).toBe(1);
		},
		{ ignore: ["scratch/"] },
	);
}, 180_000);

test("TEST-16: a deleted tracked file (rm and git rm) suppresses and contributes nothing", async () => {
	await withSmall(async (sb, repo) => {
		const legacy = join(repo, "src/legacy.ts");
		const control = await search(sb, repo, "obsolete tariff matrix", {
			limit: 10,
		});
		expect(control.out.rows[0]?.file).toBe(legacy);
		const controlRows = control.out.rows.filter(
			(r) => r.file === legacy,
		).length;

		const check = async (label: string) => {
			const s = await search(sb, repo, "obsolete tariff matrix", { limit: 10 });
			expect({
				label,
				rows: s.out.rows.filter((r) => r.file === legacy).length,
			}).toEqual({ label, rows: 0 });
			expect({ label, deleted: num(s.out, "overlay_files_deleted") }).toEqual({
				label,
				deleted: 1,
			});
			const suppressed = num(s.out, "overlay_suppressed_rows");
			expect(suppressed).toBeGreaterThan(0);
			expect(suppressed).toBeGreaterThanOrEqual(controlRows);
			expect({ label, texts: s.overlayTexts }).toEqual({ label, texts: [] });
		};
		rmSync(legacy);
		await check("unstaged rm");
		git(sb, repo, "checkout", "--", "src/legacy.ts");
		git(sb, repo, "rm", "-q", "src/legacy.ts");
		await check("staged git rm");
	});
}, 180_000);

test("TEST-17: git-dirty but already indexed → index rows served, nothing suppressed or embedded", async () => {
	await withSmall(async (sb, repo) => {
		const shipping = join(repo, "src/shipping.ts");
		writeFileSync(
			shipping,
			fSmall()["src/shipping.ts"].replace("days + 2", "days + 3"),
		);
		await indexRepo(sb, repo);
		expect(porcelain(sb, repo)).toContain("src/shipping.ts");
		const s = await search(sb, repo, "estimate parcel transit", { limit: 10 });
		expect(num(s.out, "overlay_files_index_current")).toBe(1);
		expect(num(s.out, "overlay_files")).toBe(0);
		expect(num(s.out, "overlay_suppressed_rows")).toBe(0);
		expect(s.overlayTexts).toEqual([]);
		const rows = s.out.rows.filter((r) => r.file === shipping);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(r.dirty).toBe(false);
			expect(r.fields.has("branches")).toBe(true);
		}
	});
}, 180_000);

test("TEST-18: restoring a file returns to index rows", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		const served = await search(sb, repo, "quokka ledger reconcile", {
			limit: 10,
		});
		expect(served.out.rows.some((r) => r.dirty)).toBe(true);
		git(sb, repo, "checkout", "--", "src/billing.ts");
		const s = await search(sb, repo, "legacy refund path", { limit: 10 });
		const off = await search(sb, repo, "legacy refund path", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		expect(s.out.rows.some((r) => r.dirty)).toBe(false);
		expect(resultLines(s.out)).toEqual(resultLines(off.out));
		expect(num(s.out, "overlay_suppressed_rows")).toBe(0);
	});
}, 180_000);

test("TEST-21: --no-dirty turns the overlay off for one search", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithoutLegacy());
		const s = await search(sb, repo, "legacy refund path", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		expect(s.out.header.get("overlay")).toBe("off");
		expect(s.out.header.get("overlay_reason")).toBe("flag");
		expect(s.overlayTexts).toEqual([]);
		expect(s.out.rows.some((r) => r.dirty)).toBe(false);
		expect(s.out.rows.some((r) => r.name === "legacyRefundPath")).toBe(true);
		expect(num(s.out, "overlay_suppressed_rows")).toBe(0);
	});
}, 180_000);

test("TEST-22: dirtyOverlay:false — project, global, and project-over-global precedence", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithoutLegacy());
		const projectCfg = join(repo, "mnemex.json");
		const cases: {
			label: string;
			global?: boolean;
			project?: boolean;
			expectOn: boolean;
		}[] = [
			{ label: "a: project false", project: false, expectOn: false },
			{ label: "b: global false", global: false, expectOn: false },
			{
				label: "c: global false, project true",
				global: false,
				project: true,
				expectOn: true,
			},
			{
				label: "d: global true, project false",
				global: true,
				project: false,
				expectOn: false,
			},
		];
		for (const c of cases) {
			writeGlobalConfig(
				sb,
				c.global === undefined ? {} : { dirtyOverlay: c.global },
			);
			if (c.project === undefined) rmSync(projectCfg, { force: true });
			else
				writeFileSync(
					projectCfg,
					`${JSON.stringify({ dirtyOverlay: c.project })}\n`,
				);
			const s = await search(sb, repo, "legacy refund path", { limit: 10 });
			const stale = s.out.rows.some((r) => r.name === "legacyRefundPath");
			if (c.expectOn) {
				expect({
					c: c.label,
					overlay: s.out.header.get("overlay"),
					stale,
				}).toEqual({
					c: c.label,
					overlay: "on",
					stale: false,
				});
				expect(num(s.out, "overlay_suppressed_rows")).toBeGreaterThan(0);
			} else {
				const reason = s.out.header.get("overlay_reason") ?? "";
				expect({
					c: c.label,
					overlay: s.out.header.get("overlay"),
					stale,
					texts: s.overlayTexts,
				}).toEqual({
					c: c.label,
					overlay: "off",
					stale: true,
					texts: [],
				});
				expect(reason).not.toBe("");
				expect(reason).not.toBe("flag");
			}
		}
	});
}, 240_000);

test("TEST-23: a typo of --no-dirty is rejected and NOTHING runs", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		const before = snapshot(sb.root);
		for (const typo of ["--no-dirtyy", "--nodirty", "--no-dirt"]) {
			sb.embedder.reset();
			const r = await runMnemex(
				sb,
				["--agent", "search", "quokka", "-p", repo, typo],
				{ cwd: repo },
			);
			const out = r.stdout + r.stderr;
			expect({ typo, code: r.code }).toEqual({ typo, code: 1 });
			expect(out).toMatch(/^error=unknown_flag /im);
			expect(out).toContain(`value=${typo}`);
			expect({
				typo,
				suggests: out.includes("Did you mean --no-dirty?"),
			}).toEqual({ typo, suggests: true });
			expect({ typo, requests: sb.embedder.journal.length }).toEqual({
				typo,
				requests: 0,
			});
		}
		expect(diffSnapshots(before, snapshot(sb.root))).toEqual([]);
		expect(existsSync(join(repo, ".mnemex", "dirty-overlay"))).toBe(false);
	});
}, 180_000);

test("TEST-24: `--` ends flag parsing", async () => {
	await withSmall(async (sb, repo) => {
		const r = await runMnemex(
			sb,
			["--agent", "search", "-p", repo, "--no-reindex", "--", "-foo"],
			{ cwd: repo },
		);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toContain("query=-foo");
	});
}, 120_000);

test("TEST-28: header keys always present; row-suffix order — in every overlay state", async () => {
	await withSmall(async (sb, repo) => {
		// each search() call asserts the contract (14 overlay keys, 3 penalty keys, token order)
		const clean = await search(sb, repo, "compute invoice total");
		expect([
			clean.out.header.get("overlay"),
			clean.out.header.get("overlay_reason"),
		]).toEqual(["on", "index-current"]);
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		const dirty = await search(sb, repo, "quokka ledger reconcile");
		expect([
			dirty.out.header.get("overlay"),
			dirty.out.header.get("overlay_reason"),
		]).toEqual(["on", "dirty"]);
		expect(dirty.out.rows.some((r) => r.dirty)).toBe(true);
		const off = await search(sb, repo, "quokka ledger reconcile", {
			flags: ["--no-dirty"],
		});
		expect([
			off.out.header.get("overlay"),
			off.out.header.get("overlay_reason"),
		]).toEqual(["off", "flag"]);
		const kw = await search(sb, repo, "quokka", { flags: ["--keyword"] });
		expect([
			kw.out.header.get("overlay"),
			kw.out.header.get("overlay_reason"),
		]).toEqual(["off", "keyword-only"]);
		// skipped: more candidate files than the overlay's cap (2 000) → skipped/too-large
		const many: Record<string, string> = {};
		for (let i = 0; i < 2001; i++)
			many[`gen/g${i}.ts`] = `export const generatedSlot${i} = ${i};\n`;
		writeFiles(repo, many);
		const skipped = await search(sb, repo, "quokka ledger reconcile");
		expect([
			skipped.out.header.get("overlay"),
			skipped.out.header.get("overlay_reason"),
		]).toEqual(["skipped", "too-large"]);
		expect(skipped.out.rows.length).toBeGreaterThan(0);
		expect(skipped.out.rows.some((r) => r.dirty)).toBe(false);
	});
}, 180_000);

test("TEST-29: a poor overlay match does not outrank a strong index match (D-MERGE, absolute)", async () => {
	await withSmall(async (sb, repo) => {
		writeFiles(repo, UNRELATED);
		let overlayInTop10 = 0;
		let slots = 0;
		for (const q of INDEX_QUERIES) {
			const base = await search(sb, repo, q, {
				limit: 10,
				flags: ["--no-dirty"],
			});
			const s = await search(sb, repo, q, { limit: 10 });
			expect(num(s.out, "overlay_files")).toBe(4);
			const top = s.out.rows[0];
			expect({ q, top: top?.span, dirty: top?.dirty }).toEqual({
				q,
				top: base.out.rows[0]?.span,
				dirty: false,
			});
			overlayInTop10 += s.out.rows.filter((r) => r.dirty).length;
			slots += s.out.rows.length;
		}
		console.log(`TEST-29 overlay share of top-10 = ${overlayInTop10}/${slots}`);
	});
}, 240_000);

test("TEST-30: an unchanged chunk of an edited file keeps its rank", async () => {
	await withSmall(async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		writeFileSync(
			billing,
			fSmall()["src/billing.ts"].replace(
				'if (kg < 1) return "light";',
				'if (kg < 2) return "light";',
			),
		);
		const off = await search(sb, repo, "computeInvoiceTotal", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		const on = await search(sb, repo, "computeInvoiceTotal", { limit: 10 });
		const at = lineOf(billing, "computeInvoiceTotal");
		expect(
			rankOf(
				off.out.rows,
				(r) => r.file === billing && r.line <= at && at <= r.endLine,
			),
		).toBe(1);
		expect(
			rankOf(
				on.out.rows,
				(r) => r.file === billing && r.dirty && r.line <= at && at <= r.endLine,
			),
		).toBe(1);
	});
}, 180_000);
