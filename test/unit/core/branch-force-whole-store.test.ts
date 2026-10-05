/**
 * The whole-store clears STAY whole-store (architecture §4.5's producer table).
 *
 * §4.5 lists five producers of a clear and they do NOT mean the same thing:
 *
 *   | user `--force`            | THIS BRANCH  | `narrowBranch(branchId)` |
 *   | `--force-all`             | whole store  | `rebuildStore()`         |
 *   | dimension-mismatch repair | whole store  | vector width is a store-wide property |
 *   | `onModelMismatch: force-model` | whole store | the model is a store-wide property |
 *   | v4/v5 migration           | whole store  | the schema is store-wide  |
 *
 * D3 narrowed the FIRST one. The other four must not move with it, and each has
 * its OWN reason to empty everything — so each gets its own assertion here
 * rather than one test standing in for three. The mechanism that keeps them
 * apart is `alreadyCleared`, which is set by every whole-store branch before
 * the `if (force)` block is reached.
 *
 * `--force-all` itself is asserted in `branch-force-scope.test.ts`, beside the
 * branch-scoped force it contrasts with.
 *
 * Every count is read through an INDEPENDENT connection: `lancedb.connect()`
 * for rows, `better-sqlite3` for membership and the tree-scoped tables.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getIndexDbPathFor,
	getStoreMetaPathFor,
	getVectorStorePathFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	runForceScopeChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

interface Fixture {
	project: string;
	scratch: string;
	indexDb: string;
	vectors: string;
	storeDir: string;
	featId: number;
	git: (cwd: string, ...args: string[]) => string;
	cleanup: () => void;
}

/** `main` and `feat` both indexed into one store, with `main` checked out. */
async function twoIndexedBranches(prefix: string): Promise<Fixture> {
	const sandbox = createGitSandbox(prefix);
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	writeSource(project, "src/shared.ts", 3, "shared");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");
	const first = await runCli(["index"], scratch, project);
	if (first.exitCode !== 0) throw new Error(`index on main: ${first.stderr}`);

	sandbox.git(project, "checkout", "-q", "-b", "feat");
	writeSource(project, "src/only-feat.ts", 4, "feat");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "feat only");
	const second = await runCli(["index"], scratch, project);
	if (second.exitCode !== 0) throw new Error(`index on feat: ${second.stderr}`);
	sandbox.git(project, "checkout", "-q", "main");

	const loc = resolveStoreLocation(project);
	const registry = JSON.parse(
		readFileSync(join(loc.storeDir, "branches.json"), "utf8"),
	) as { branches: Array<{ id: number; label: string }> };
	const feat = registry.branches.find((b) => b.label === "feat");
	if (feat === undefined) throw new Error("no `feat` entry in branches.json");
	return {
		project,
		scratch,
		indexDb: getIndexDbPathFor(loc),
		vectors: getVectorStorePathFor(loc),
		storeDir: loc.storeDir,
		featId: feat.id,
		git: sandbox.git,
		cleanup: () => sandbox.cleanup(),
	};
}

function countFor(indexDb: string, table: string, branchId: number): number {
	const db = new Database(indexDb, { readonly: true });
	try {
		const row = db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE branch_id = ?`)
			.get(branchId) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

/** Everything the OTHER branch holds, in one object. */
function otherBranchState(fx: Fixture): Record<string, number> {
	return {
		membership: countFor(fx.indexDb, "chunk_branches", fx.featId),
		files: countFor(fx.indexDb, "files", fx.featId),
		symbols: countFor(fx.indexDb, "symbols", fx.featId),
	};
}

async function featRowCount(fx: Fixture): Promise<number> {
	return (await storeRows(fx.vectors)).filter((r) =>
		String(r.filePath).includes("only-feat"),
	).length;
}

/** The assertion all three share: the other branch kept NOTHING. */
async function expectWholeStoreCleared(fx: Fixture): Promise<void> {
	expect(otherBranchState(fx)).toEqual({
		membership: 0,
		files: 0,
		symbols: 0,
	});
	expect(await featRowCount(fx)).toBe(0);
	// The registry is not the store: `feat` keeps its entry and its id, which is
	// what the emptiness signal reports on until it is indexed again.
	const registry = JSON.parse(
		readFileSync(join(fx.storeDir, "branches.json"), "utf8"),
	) as { branches: Array<{ id: number; label: string }> };
	expect(registry.branches.find((b) => b.label === "feat")?.id).toBe(fx.featId);
}

describe("§4.5's whole-store producers are untouched by D3", () => {
	test(
		"an INDEX VERSION upgrade rebuilds the store, every branch",
		async () => {
			const fx = await twoIndexedBranches("mnemex-whole-upgrade-");
			try {
				expect(otherBranchState(fx).membership).toBeGreaterThan(0);
				// The store now claims to have been written by the previous index
				// version, which is §6.1's generic `recordedVersion <
				// CURRENT_INDEX_VERSION` trigger — no branch of its own per bump.
				const metaPath = getStoreMetaPathFor(resolveStoreLocation(fx.project));
				const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
					indexVersion?: number;
				};
				const current = meta.indexVersion ?? 0;
				expect(current).toBeGreaterThan(1);
				meta.indexVersion = current - 1;
				writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

				// An ORDINARY run: nothing here asks for a force.
				const run = await runCli(["--agent", "index"], fx.scratch, fx.project);
				expect(run.exitCode, run.stderr).toBe(0);
				expect(run.stdout).toContain(
					`upgraded_from_index_version=${current - 1}`,
				);
				expect(run.stdout).toContain("force_scope=store");
				await expectWholeStoreCleared(fx);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a MODEL CHANGE rebuilds the store, every branch",
		async () => {
			const fx = await twoIndexedBranches("mnemex-whole-model-");
			try {
				expect(otherBranchState(fx).membership).toBeGreaterThan(0);
				// An explicit `--model` is `force-model` (indexer.ts): the stored
				// vectors were built by another model, and a vector's model is a
				// property of the STORE, not of a tree.
				const run = await runCli(
					["--agent", "index", "--model", "test-other-model"],
					fx.scratch,
					fx.project,
				);
				expect(run.exitCode, run.stderr).toBe(0);
				expect(run.stdout).toContain("force_scope=store");
				await expectWholeStoreCleared(fx);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the CORRUPTION repair rebuilds the store, every branch",
		async () => {
			const fx = await twoIndexedBranches("mnemex-whole-corrupt-");
			try {
				expect(otherBranchState(fx).membership).toBeGreaterThan(0);
				// A `FixedSizeList[0]` column cannot be created any more
				// (CLAUDE.md #15), so the child produces the SIGNAL and every
				// decision below it is the production path. `index(false)`: the
				// repair is not a force the caller asked for.
				const run = await runForceScopeChild("corrupt", fx.project, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				expect(
					(run.result?.branch as { forceScope?: string } | null)?.forceScope,
				).toBe("store");
				await expectWholeStoreCleared(fx);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
