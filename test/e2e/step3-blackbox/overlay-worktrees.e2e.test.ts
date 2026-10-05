/**
 * Step 3 black-box — R3.6/R3.7 per-worktree overlay and dirty-set boundaries
 * (test-plan TEST-19, TEST-20, TEST-41, TEST-46).
 */
import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { billingWithQuokka } from "./fixtures";
import {
	allTexts,
	assertNoSecuritySpawn,
	createSandbox,
	diffSnapshots,
	findDirs,
	fSmall,
	git,
	indexRepo,
	isInsidePath,
	lineOf,
	makeRepo,
	rowsCovering,
	type Sandbox,
	search,
	snapshot,
	writeFiles,
} from "./harness";

const ALPHA =
	"export function alphaOnlyKestrel(seed: number): number {\n  const kestrelAlpha = seed * 5;\n  return kestrelAlpha;\n}\n";
const BETA =
	"export function betaOnlyHeron(seed: number): number {\n  const heronBeta = seed * 7;\n  return heronBeta;\n}\n";

async function twoWorktrees(
	fn: (sb: Sandbox, a: string, b: string, storeDirs: string[]) => Promise<void>,
): Promise<void> {
	const sb = createSandbox();
	try {
		const a = makeRepo(sb, "A", fSmall());
		const ia = await indexRepo(sb, a);
		git(sb, a, "worktree", "add", "-q", "-b", "feature", join(sb.repos, "B"));
		const b = realpathSync(join(sb.repos, "B"));
		const ib = await indexRepo(sb, b);
		const storeDirs = [
			ia.header.get("store_dir") ?? "",
			ib.header.get("store_dir") ?? "",
		];
		await fn(sb, a, b, storeDirs);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

test("TEST-19: a second worktree never sees the first worktree's dirty work (both directions)", async () => {
	await twoWorktrees(async (sb, a, b) => {
		writeFileSync(join(a, "src/alpha.ts"), ALPHA);
		writeFileSync(join(b, "src/beta.ts"), BETA);

		const aAlpha = await search(sb, a, "alpha only kestrel", { limit: 10 });
		expect(aAlpha.out.rows[0]?.file).toBe(join(a, "src/alpha.ts"));
		expect(aAlpha.out.rows[0]?.dirty).toBe(true);
		const overlayA = findDirs(a, "dirty-overlay");
		expect(overlayA.length).toBe(1);
		const snapA = snapshot(overlayA[0] as string);

		const bAlpha = await search(sb, b, "alpha only kestrel", { limit: 10 });
		expect(bAlpha.out.rows.filter((r) => r.file.includes("alpha.ts"))).toEqual(
			[],
		);
		expect(bAlpha.out.rows.filter((r) => r.file.startsWith(`${a}/`))).toEqual(
			[],
		);
		const bBeta = await search(sb, b, "beta only heron", { limit: 10 });
		expect(bBeta.out.rows[0]?.file).toBe(join(b, "src/beta.ts"));
		expect(bBeta.out.rows[0]?.dirty).toBe(true);
		// B's searches did not touch A's overlay bytes
		expect(diffSnapshots(snapA, snapshot(overlayA[0] as string))).toEqual([]);

		const overlayB = findDirs(b, "dirty-overlay");
		expect(overlayB.length).toBe(1);
		const snapB = snapshot(overlayB[0] as string);
		const aBeta = await search(sb, a, "beta only heron", { limit: 10 });
		expect(aBeta.out.rows.filter((r) => r.file.includes("beta.ts"))).toEqual(
			[],
		);
		expect(aBeta.out.rows.filter((r) => r.file.startsWith(`${b}/`))).toEqual(
			[],
		);
		expect(diffSnapshots(snapB, snapshot(overlayB[0] as string))).toEqual([]);
	});
}, 240_000);

test("TEST-20: the overlay store is per-worktree and never inside the shared store", async () => {
	await twoWorktrees(async (sb, a, b, storeDirs) => {
		writeFileSync(join(a, "src/alpha.ts"), ALPHA);
		writeFileSync(join(b, "src/beta.ts"), BETA);
		await search(sb, a, "alpha only kestrel");
		await search(sb, b, "beta only heron");
		expect(storeDirs[0]).not.toBe("");
		expect(storeDirs[0]).toBe(storeDirs[1]); // one shared store (D-1)
		const shared = realpathSync(storeDirs[0] as string);
		const overlays = findDirs(sb.root, "dirty-overlay");
		expect(overlays.length).toBe(2);
		const [o1, o2] = overlays as [string, string];
		expect(o1).not.toBe(o2);
		for (const o of overlays)
			expect({ o, insideShared: isInsidePath(o, shared) }).toEqual({
				o,
				insideShared: false,
			});
		const owners = overlays
			.map((o) => (isInsidePath(o, a) ? "A" : isInsidePath(o, b) ? "B" : "?"))
			.sort();
		expect(owners).toEqual(["A", "B"]);
		// overlay rows never entered the shared store
		const viaIndex = await search(sb, b, "alpha only kestrel", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		expect(
			viaIndex.out.rows.filter((r) => r.file.includes("alpha.ts")),
		).toEqual([]);
		const viaIndexA = await search(sb, a, "alpha only kestrel", {
			limit: 10,
			flags: ["--no-dirty"],
		});
		expect(
			viaIndexA.out.rows.filter((r) => r.file.includes("alpha.ts")),
		).toEqual([]);
	});
}, 240_000);

test("TEST-41: GIT_DIR / GIT_WORK_TREE in the environment cannot redirect the dirty set", async () => {
	const sb = createSandbox();
	try {
		const x = makeRepo(sb, "X", fSmall());
		const y = makeRepo(sb, "Y", fSmall());
		await indexRepo(sb, x);
		const billing = join(x, "src/billing.ts");
		writeFileSync(billing, billingWithQuokka());
		const s = await search(sb, x, "quokka ledger reconcile", {
			env: { GIT_DIR: join(y, ".git"), GIT_WORK_TREE: y },
		});
		const at = lineOf(billing, "quokkaLedgerReconcile");
		expect(rowsCovering(s.out.rows, billing, at).some((r) => r.dirty)).toBe(
			true,
		);
		expect(s.out.header.get("overlay")).toBe("on");
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 180_000);

test("TEST-46: project = subdirectory — dirty files outside it are ignored", async () => {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "mono", {
			"pkg/src/core.ts": fSmall()["src/billing.ts"],
			"other/legacy.ts": fSmall()["src/legacy.ts"],
		});
		const pkg = join(repo, "pkg");
		await indexRepo(sb, pkg);
		writeFiles(repo, {
			"pkg/src/fresh.ts":
				"export function heronPkgSignal(n: number): number {\n  const heronSignal = n + 1;\n  return heronSignal;\n}\n",
			"other/out.ts":
				"export function outsideCormorantSignal(n: number): number {\n  const cormorantSignal = n + 2;\n  return cormorantSignal;\n}\n",
		});
		const s = await search(sb, pkg, "heron pkg signal", { limit: 10 });
		expect(s.out.rows[0]?.file).toBe(join(pkg, "src/fresh.ts"));
		expect(s.out.rows[0]?.dirty).toBe(true);
		expect(
			allTexts(s.journal).filter((t) => t.includes("outsideCormorant")),
		).toEqual([]);
		expect(s.out.rows.filter((r) => r.file.includes("/other/"))).toEqual([]);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 180_000);
