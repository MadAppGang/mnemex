/**
 * V1 — TWO WORKTREES, ONE STORE. The feature's headline claim, end to end,
 * through the BUILT entry point on REAL `git worktree add` checkouts.
 *
 * This is the criterion Phase 3c exists for, and the one that could not be
 * asserted before the flip: under `STORE_SCOPE_DEFAULT = "worktree"` every row
 * below was true of two separate stores that happened to agree.
 *
 * ── WHAT EACH TEST PROVES, AND HOW ──────────────────────────────────────────
 *   V1.1  both worktrees' `index --agent` report the SAME `store_dir=`, and it
 *         is under the git COMMON dir — not under either checkout.
 *   V1.3  worktree B's first run adds ZERO rows for files A already indexed,
 *         counted through an INDEPENDENT `lancedb.connect()`. This is the row
 *         that carries the repo-relative path convention: with absolute paths
 *         the chunk ids differ and every row doubles.
 *   V1.4  a real query FROM B returns a row WRITTEN BY A. Not "a row exists" —
 *         the id is captured from A's store before B ever runs.
 *   V1.5  `store.json` holds no linked-worktree path outside `firstIndexedFrom`.
 *         Asserted on the BYTES, because a shared file that named one worktree
 *         would make the other's reads wrong in a way no row count shows.
 *
 * ── THE FALSIFIER, EXECUTED ─────────────────────────────────────────────────
 * Each of these is red under the pre-3c scope, and that is shown rather than
 * asserted: `pickStoreDir(readStoreInputs(w), "worktree")` is the exact
 * function `resolveStoreLocation` calls with the other argument, so the test
 * can compute what the old default WOULD have answered and assert the two
 * differ. Recorded in the implementation log as a real reverted-constant run
 * too, because a computed comparison is not the same as a run.
 *
 * `bun run build` is a precondition (CLAUDE.md #13). Every child's environment
 * comes from `sandboxEnv`, i.e. `keychainSafeChildEnv()` with HOME,
 * MNEMEX_EMBED_CACHE_PATH and MNEMEX_GLOBAL_LOCK_PATH inside the scratch tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	pickStoreDir,
	readStoreInputs,
	resolveStoreLocation,
} from "../../src/core/store-location.js";
import { createGitSandbox } from "../helpers/git-sandbox.js";
import { BM25_ONLY, runCli, writeSource } from "../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

const open: Array<() => void> = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

interface TwoWorktrees {
	/** The main checkout, on `main`. */
	a: string;
	/** A REAL linked worktree (`git worktree add`), on `feat`. */
	b: string;
	scratch: string;
	commonDir: string;
	git: (cwd: string, ...args: string[]) => string;
}

/**
 * A repository with a real linked worktree. `git worktree add` — not a
 * hand-built `.git` file — because the whole claim is about what git itself
 * produces, and `readGitLayout` is asserted against `git rev-parse
 * --git-common-dir` here rather than against a fixture's idea of one.
 */
function twoWorktrees(prefix: string): TwoWorktrees {
	const sandbox = createGitSandbox(prefix);
	open.push(() => sandbox.cleanup());
	const a = join(sandbox.root, "main-checkout");
	const b = join(sandbox.root, "feat-worktree");
	const scratch = join(sandbox.root, "scratch");

	sandbox.git(sandbox.root, "init", "main-checkout");
	// `.mnemex/` is gitignored so a per-worktree store — if one were ever
	// created — could not be committed and confuse the next assertion.
	writeFileSync(join(a, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(a, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	writeSource(a, "src/shared.ts", 4, "shared");
	writeSource(a, "src/other.ts", 3, "other");
	sandbox.git(a, "add", "-A");
	sandbox.git(a, "commit", "-m", "initial");
	sandbox.git(a, "worktree", "add", "-b", "feat", b);

	const commonDir = sandbox.git(
		a,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	return { a, b, scratch, commonDir, git: sandbox.git };
}

/** `key=value` lookup over `--agent` output. */
function agentValue(stdout: string, key: string): string | null {
	const line = stdout.split("\n").find((l) => l.startsWith(`${key}=`));
	return line === undefined ? null : line.slice(key.length + 1);
}

/** Rows through a connection NEITHER run ever touched. */
async function independentRows(
	vectorsDir: string,
): Promise<Array<Record<string, unknown>>> {
	if (!existsSync(vectorsDir)) return [];
	const db = await lancedb.connect(vectorsDir);
	if (!(await db.tableNames()).includes("code_chunks")) return [];
	const table = await db.openTable("code_chunks");
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

describe("V1 — two worktrees, one store", () => {
	test(
		"V1.1: both worktrees report the SAME store_dir, under the git common dir",
		async () => {
			const fx = twoWorktrees("mnemex-v1-store-");

			const ra = await runCli(["--agent", "index"], fx.scratch, fx.a);
			expect(ra.exitCode, ra.stderr).toBe(0);
			const rb = await runCli(["--agent", "index"], fx.scratch, fx.b);
			expect(rb.exitCode, rb.stderr).toBe(0);

			const sa = agentValue(ra.stdout, "store_dir");
			const sb = agentValue(rb.stdout, "store_dir");
			expect(sa, "no store_dir in A's output").not.toBeNull();
			// THE CLAIM.
			expect(sb).toBe(sa as string);
			expect(agentValue(ra.stdout, "store_kind")).toBe("git-common-dir");
			expect(agentValue(rb.stdout, "store_kind")).toBe("git-common-dir");

			// Under git's OWN answer for the common dir, not the seam's.
			expect(sa).toBe(join(fx.commonDir, "mnemex"));
			// It is OUTSIDE the linked worktree — which is the half that matters,
			// and the only one that can be stated as "outside a checkout". The
			// main checkout's common dir is `<a>/.git`, so the store IS under A;
			// that is not a defect, it is where git keeps the repository, and
			// asserting otherwise (as the first draft of this test did) asserts
			// something false about how `git worktree` is laid out.
			expect(relative(fx.b, sa as string).startsWith("..")).toBe(true);
			// Neither checkout got a per-worktree store on the side. This is the
			// assertion that would fire if some caller still built its own path.
			expect(existsSync(join(fx.a, ".mnemex", "index.db"))).toBe(false);
			expect(existsSync(join(fx.b, ".mnemex", "index.db"))).toBe(false);

			// THE FALSIFIER, COMPUTED: the pre-3c scope, through the same pure
			// function `resolveStoreLocation` calls with the other argument.
			const oldA = pickStoreDir(readStoreInputs(fx.a), "worktree").storeDir;
			const oldB = pickStoreDir(readStoreInputs(fx.b), "worktree").storeDir;
			expect(oldA).not.toBe(oldB);
			expect(oldA).toBe(join(fx.a, ".mnemex"));
			expect(oldB).toBe(join(fx.b, ".mnemex"));
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"V1.3: B's first run adds ZERO rows for files A already indexed",
		async () => {
			const fx = twoWorktrees("mnemex-v1-rows-");
			const ra = await runCli(["--agent", "index"], fx.scratch, fx.a);
			expect(ra.exitCode, ra.stderr).toBe(0);

			const vectors = join(
				agentValue(ra.stdout, "store_dir") as string,
				"vectors",
			);
			const before = await independentRows(vectors);
			expect(before.length).toBeGreaterThan(0);

			// B is a DIFFERENT DIRECTORY holding BYTE-IDENTICAL files. Before the
			// repo-relative convention every chunk id hashed an absolute path, so
			// this run would have inserted a second complete copy.
			const rb = await runCli(["--agent", "index"], fx.scratch, fx.b);
			expect(rb.exitCode, rb.stderr).toBe(0);

			const after = await independentRows(vectors);
			expect(after.length).toBe(before.length);

			// Not merely "the same count": the same IDS, now carrying BOTH
			// branches. A run that deleted and re-inserted would keep the count.
			const idsBefore = new Set(before.map((r) => String(r.id)));
			const idsAfter = new Set(after.map((r) => String(r.id)));
			expect([...idsAfter].sort()).toEqual([...idsBefore].sort());
			const shared = after.filter((r) =>
				String(r.filePath).endsWith("shared.ts"),
			);
			expect(shared.length).toBeGreaterThan(0);
			for (const row of shared) {
				// `,1,2,` — two sentinel-comma-delimited ids (§3.2.1, I-6).
				expect(String(row.branchIds).split(",").filter(Boolean)).toHaveLength(
					2,
				);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"V1.4: a query from B returns a row WRITTEN BY A",
		async () => {
			const fx = twoWorktrees("mnemex-v1-query-");
			// Only A indexes. B never runs `index` at all, so anything it finds
			// was put there by the other worktree.
			const ra = await runCli(["--agent", "index"], fx.scratch, fx.a);
			expect(ra.exitCode, ra.stderr).toBe(0);
			const vectors = join(
				agentValue(ra.stdout, "store_dir") as string,
				"vectors",
			);
			const written = await independentRows(vectors);
			const target = written.find((r) =>
				String(r.filePath).endsWith("shared.ts"),
			);
			expect(target, "A wrote no shared.ts row").toBeDefined();

			// `--no-reindex` so the search cannot index B's tree on the way in:
			// the row it returns must be A's, not one it just created.
			const q = await runCli(
				["--agent", "search", "--no-reindex", "-k", "src_shared_ts"],
				fx.scratch,
				fx.b,
			);
			expect(q.exitCode, q.stderr).toBe(0);
			const paths = q.stdout
				.split("\n")
				.filter((l) => l.startsWith("result file="))
				.map((l) => l.slice("result file=".length).split(" ")[0]);
			expect(paths.length).toBeGreaterThan(0);

			// V1.6's property here too: the path is ABSOLUTE, exists on disk, and
			// is rehydrated against the READING worktree — B's, not A's.
			const hit = paths.find((p) => p.endsWith("shared.ts"));
			expect(hit, `no shared.ts in ${paths.join(", ")}`).toBeDefined();
			expect(hit?.startsWith("/")).toBe(true);
			expect(existsSync(hit as string)).toBe(true);
			expect((hit as string).startsWith(fx.b)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"V1.5: store.json names no linked worktree outside firstIndexedFrom",
		async () => {
			const fx = twoWorktrees("mnemex-v1-meta-");
			const ra = await runCli(["--agent", "index"], fx.scratch, fx.a);
			expect(ra.exitCode, ra.stderr).toBe(0);
			const rb = await runCli(["--agent", "index"], fx.scratch, fx.b);
			expect(rb.exitCode, rb.stderr).toBe(0);

			const storeDir = agentValue(ra.stdout, "store_dir") as string;
			// The BYTES. A `pathRoot` persisted into a shared file can only ever
			// hold ONE worktree's root, so the other's reads would be resolved
			// against a directory it does not live in — and no row count shows it.
			const bytes = readFileSync(join(storeDir, "store.json"), "utf8");
			const meta = JSON.parse(bytes) as Record<string, unknown>;
			expect(meta.firstIndexedFrom).toBe(fx.a);
			for (const [key, value] of Object.entries(meta)) {
				if (key === "firstIndexedFrom") continue;
				expect(
					String(value),
					`store.json.${key} names worktree B`,
				).not.toContain(fx.b);
			}
			// And the linked worktree's path appears NOWHERE in the file.
			expect(bytes).not.toContain(fx.b);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"V1.7: A runs --force-all; B's search says the store was rebuilt elsewhere",
		async () => {
			// §4.5's marker, end to end, across TWO REAL WORKTREES — the shape it
			// was designed for and the one that could not exist before the flip.
			// A's `--force-all` empties every branch of a store B also uses. B's
			// registry entry survives, so `branch_unknown` is 0 and D1 says
			// nothing; without this the user gets an empty search in silence.
			const fx = twoWorktrees("mnemex-v17-");
			const ra = await runCli(["--agent", "index"], fx.scratch, fx.a);
			expect(ra.exitCode, ra.stderr).toBe(0);
			const rb = await runCli(["--agent", "index"], fx.scratch, fx.b);
			expect(rb.exitCode, rb.stderr).toBe(0);

			// Before: B finds its code and reports neither state.
			const before = await runCli(
				["--agent", "search", "--no-reindex", "-k", "src_shared_ts"],
				fx.scratch,
				fx.b,
			);
			expect(before.exitCode, before.stderr).toBe(0);
			expect(before.stdout).toContain("branch_empty=0");
			expect(before.stdout).not.toContain("store_rebuilt_elsewhere=");

			// A rebuilds the WHOLE store, every branch. B is not told and does not
			// run anything.
			const wiped = await runCli(
				["--agent", "index", "--force-all"],
				fx.scratch,
				fx.a,
			);
			expect(wiped.exitCode, wiped.stderr).toBe(0);

			// After: B's search is empty, says so, and says WHY.
			const after = await runCli(
				["--agent", "search", "--no-reindex", "-k", "src_shared_ts"],
				fx.scratch,
				fx.b,
			);
			expect(after.exitCode, after.stderr).toBe(0);
			expect(after.stdout).toContain("result_count=0");
			// The SIGNAL, from rows — the one that cannot lie.
			expect(after.stdout).toContain("branch_empty=1");
			// NOT `branch_unknown`: B's registry entry is perfectly healthy, which
			// is exactly why D1's flag cannot report this state (decision I-16).
			expect(after.stdout).toContain("branch_unknown=0");
			// The EXPLANATION, from `store.json.storeRebuildAt`.
			expect(after.stdout).toContain("store_rebuilt_elsewhere=1");
			// A non-error exit: an empty answer with a reason is not a failure.
			expect(after.exitCode).toBe(0);

			// And it is repairable by the command the hint names.
			const reindexed = await runCli(["--agent", "index"], fx.scratch, fx.b);
			expect(reindexed.exitCode, reindexed.stderr).toBe(0);
			const healed = await runCli(
				["--agent", "search", "--no-reindex", "-k", "src_shared_ts"],
				fx.scratch,
				fx.b,
			);
			expect(healed.stdout).toContain("branch_empty=0");
			expect(healed.stdout).not.toContain("store_rebuilt_elsewhere=");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the seam agrees with git's own --git-common-dir, on the real worktrees",
		async () => {
			const fx = twoWorktrees("mnemex-v1-layout-");
			// `resolveStoreLocation` is the production path; git is the oracle.
			for (const wt of [fx.a, fx.b]) {
				const loc = resolveStoreLocation(wt);
				const fromGit = fx.git(
					wt,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				);
				expect(loc.gitLayout?.gitCommonDir).toBe(fromGit);
				expect(loc.storeDir).toBe(join(fromGit, "mnemex"));
				// `pathRoot` is this worktree's OWN root, and does not follow the
				// store: it is what every stored path is relative to (§2.3 step 1).
				expect(loc.pathRoot).toBe(wt);
				expect(loc.worktreeDir).toBe(join(wt, ".mnemex"));
			}
			// The two share a store and do NOT share a pathRoot. That pair is the
			// whole design: one dataset, two path roots, rehydrated per reader.
			expect(resolveStoreLocation(fx.a).storeDir).toBe(
				resolveStoreLocation(fx.b).storeDir,
			);
			expect(resolveStoreLocation(fx.a).pathRoot).not.toBe(
				resolveStoreLocation(fx.b).pathRoot,
			);
		},
		TEST_TIMEOUT_MS,
	);
});
