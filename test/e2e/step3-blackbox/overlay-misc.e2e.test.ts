/**
 * Step 3 black-box — git hygiene, path spelling, rg, human output, liveness,
 * stability and safety (test-plan TEST-40, 45, 47, 48, 49, 51, 52).
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { billingWithQuokka } from "./fixtures";
import {
	allTexts,
	assertNoSecuritySpawn,
	createSandbox,
	fillerFiles,
	findDirs,
	fSmall,
	indexRepo,
	makeRepo,
	num,
	resultLines,
	runMnemex,
	runMnemexTty,
	type Sandbox,
	search,
	writeFiles,
} from "./harness";

async function withRepo(
	files: Record<string, string>,
	fn: (sb: Sandbox, repo: string) => Promise<void>,
): Promise<void> {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "repo", files);
		await indexRepo(sb, repo);
		await fn(sb, repo);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

test("TEST-40: a search never rewrites .git/index", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		writeFileSync(
			join(repo, "src/telemetry.ts"),
			"export function gitHygieneProbe(): number {\n  return 1;\n}\n",
		);
		const later = Date.now() / 1000 + 5;
		utimesSync(join(repo, "src/billing.ts"), later, later); // racy stat, same content
		const gitIndex = join(repo, ".git", "index");
		const before = {
			sha: createHash("sha256").update(readFileSync(gitIndex)).digest("hex"),
			mtime: statSync(gitIndex).mtimeMs,
		};
		for (let i = 0; i < 3; i++) await search(sb, repo, "git hygiene probe");
		const after = {
			sha: createHash("sha256").update(readFileSync(gitIndex)).digest("hex"),
			mtime: statSync(gitIndex).mtimeMs,
		};
		expect(after).toEqual(before);
	});
}, 180_000);

test("TEST-45: paths with spaces, apostrophes, underscores and non-ASCII are served and suppressed", async () => {
	const apostrophe = "src/my_file's.ts";
	const unicode = "src/ünicode name.ts"; // NFD on disk
	const fnText = (name: string, k: number) =>
		`export function ${name}(n: number): number {\n  const ${name}Value = n * ${k};\n  return ${name}Value;\n}\n`;
	await withRepo(
		{
			...fSmall(),
			[apostrophe]: `${fnText("apostropheRemovedOtter", 3)}\n${fnText("apostropheKeptMarten", 4)}`,
			[unicode]: `${fnText("unicodeRemovedLynx", 5)}\n${fnText("unicodeKeptBadger", 6)}`,
		},
		async (sb, repo) => {
			const fa = join(repo, apostrophe);
			const fu = join(repo, unicode);
			const ca = await search(sb, repo, "apostrophe removed otter", {
				limit: 10,
			});
			const cu = await search(sb, repo, "unicode removed lynx", { limit: 10 });
			expect(ca.out.rows[0]?.file).toBe(fa);
			expect(cu.out.rows[0]?.file).toBe(fu);
			const controlRows =
				ca.out.rows.filter((r) => r.file === fa).length +
				cu.out.rows.filter((r) => r.file === fu).length;

			writeFileSync(
				fa,
				`${fnText("apostropheKeptMarten", 4)}\n${fnText("apostrophePlantedNewt", 8)}`,
			);
			writeFileSync(
				fu,
				`${fnText("unicodeKeptBadger", 6)}\n${fnText("unicodePlantedEgret", 9)}`,
			);
			for (const [q, file] of [
				["apostrophe removed otter", fa],
				["unicode removed lynx", fu],
			] as const) {
				const s = await search(sb, repo, q, { limit: 10 });
				expect({
					q,
					stale: s.out.rows.filter((r) => r.file === file && !r.dirty).length,
				}).toEqual({ q, stale: 0 });
				expect(
					s.out.rows.some(
						(r) =>
							r.name === "apostropheRemovedOtter" ||
							r.name === "unicodeRemovedLynx",
					),
				).toBe(false);
				expect(num(s.out, "overlay_files")).toBe(2);
				expect(num(s.out, "overlay_suppressed_rows")).toBeGreaterThanOrEqual(
					controlRows,
				);
			}
			for (const [q, file] of [
				["apostrophe planted newt", fa],
				["unicode planted egret", fu],
			] as const) {
				const s = await search(sb, repo, q, { limit: 10 });
				expect({
					q,
					file: s.out.rows[0]?.file,
					dirty: s.out.rows[0]?.dirty,
				}).toEqual({ q, file, dirty: true });
			}
		},
	);
}, 180_000);

const RG = Bun.which("rg");

test.skipIf(!RG)(
	"TEST-47: `mnemex rg` never consults the overlay",
	async () => {
		await withRepo(fSmall(), async (sb, repo) => {
			writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
			sb.embedder.reset();
			const r = await runMnemex(sb, ["rg", "quokka"], { cwd: repo });
			expect(r.code).toBeLessThanOrEqual(1);
			expect(r.stdout).toContain("quokkaLedgerReconcile"); // ripgrep's own hit
			expect(
				allTexts(sb.embedder.journal).filter((t) =>
					t.includes("quokkaLedgerReconcile"),
				),
			).toEqual([]);
			expect(findDirs(repo, "dirty-overlay")).toEqual([]);
		});
	},
	180_000,
);

test.skipIf(process.platform !== "darwin")(
	"TEST-48: human output marks uncommitted results",
	async () => {
		await withRepo(fSmall(), async (sb, repo) => {
			writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
			const r = await runMnemexTty(
				sb,
				["search", "quokka ledger reconcile", "-p", repo, "--no-reindex"],
				{
					cwd: repo,
				},
			);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
			const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
			expect(r.code).toBe(0);
			expect(text).toContain("Including 1 uncommitted file");
			// the planted function's result carries the marker
			expect(text).toMatch(/src\/billing\.ts:\d+-\d+ \[uncommitted\]/);
		});
	},
	180_000,
);

test("TEST-49: liveness — the overlay lock is heartbeated while a large overlay builds (NFR-5)", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		writeFiles(repo, fillerFiles("Lv", 200, 3));
		sb.embedder.latencyMs = 5;
		const seen = new Map<number, number>(); // mtimeMs -> first observed (ms)
		let polling = true;
		const poll = (async () => {
			while (polling) {
				for (const dir of findDirs(join(repo, ".mnemex"), "dirty-overlay")) {
					for (const name of readdirSync(dir)) {
						if (!name.endsWith(".lock")) continue;
						try {
							const m = statSync(join(dir, name)).mtimeMs;
							if (!seen.has(m)) seen.set(m, performance.now());
						} catch {
							// released between readdir and stat
						}
					}
				}
				await Bun.sleep(50);
			}
		})();
		const s = await search(sb, repo, "compute invoice total");
		polling = false;
		await poll;
		const mtimes = [...seen.keys()].sort((a, b) => a - b);
		const gaps = mtimes.slice(1).map((m, i) => m - (mtimes[i] as number));
		console.log(
			`TEST-49 wall=${s.res.ms.toFixed(0)}ms lock mtimes=${mtimes.length} max gap=${Math.max(0, ...gaps).toFixed(0)}ms files=${s.out.header.get("overlay_files")}`,
		);
		expect(num(s.out, "overlay_files")).toBe(200);
		expect(mtimes.length).toBeGreaterThanOrEqual(3); // otherwise the observation is inconclusive
		expect(Math.max(...gaps)).toBeLessThanOrEqual(1501);
	});
}, 240_000);

test("TEST-51: index results are stable across processes where nothing changed", async () => {
	await withRepo(fSmall(), async (sb, repo) => {
		for (const q of [
			"compute invoice total",
			"obsolete tariff matrix",
			"estimate parcel transit",
			"format currency label",
			"courier zone lookup",
		]) {
			const a = await search(sb, repo, q, { limit: 10 });
			const b = await search(sb, repo, q, { limit: 10 });
			expect(resultLines(a.out)).toEqual(resultLines(b.out));
			expect(a.out.rows.length).toBeGreaterThan(0);
		}
	});
}, 180_000);

test("TEST-52: safety — the user's real files are untouched; children used the sandbox", async () => {
	const realCfg = join(homedir(), ".mnemex", "config.json");
	const stamp = () =>
		existsSync(realCfg)
			? (({ size, mtimeMs, ino }) => ({ size, mtimeMs, ino }))(
					statSync(realCfg),
				)
			: null;
	const before = stamp();
	await withRepo(fSmall(), async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		await search(sb, repo, "quokka ledger reconcile");
		expect(existsSync(sb.embedCache)).toBe(true);
		expect(statSync(sb.embedCache).size).toBeGreaterThan(0);
		expect(existsSync(sb.securityMarker)).toBe(false);
	});
	expect(stamp()).toEqual(before);
}, 180_000);
