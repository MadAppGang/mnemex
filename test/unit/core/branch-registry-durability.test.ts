/**
 * V3.20: allocation durability (architecture §3.4, round 3's C1).
 *
 * REG-1 serialises the registry's writers. Serialising them is not the same as
 * making an allocation survive a crash, and C1 was exactly that confusion. An
 * allocation held in memory until the end-of-run flush was lost on a kill while
 * rows already carried its id. The next new label was then issued the SAME id,
 * which leaks rows across branches. There are two mechanisms, and ONE ASSERTION
 * PER HALF:
 *
 *   (1) W-R1: a new label's entry is renamed to disk BEFORE resolveId returns.
 *       Kill the run after a row carrying the new id has committed, before the
 *       end-of-run flush, and the entry must already be in `branches.json`.
 *   (2) `openRegistry` raises `nextId` above every id a row carries. Write the
 *       pre-run bytes back, so the allocation is lost while rows still carry
 *       it. The next new label must get a DIFFERENT, higher id.
 *
 * One store, three worktrees (A `main`, B `feat-b`, C `feat-c`), shared through
 * MNEMEX_INDEX_DIR, as the store lock's own e2e test shares them. Each worktree
 * is a new label in that store. The rows are read through an independent
 * SQLite connection, and the registry through an independent JSON.parse of its
 * bytes, never through `IndexResult`.
 *
 * FALSIFIED (both reverts executed, recorded in the implementation log):
 * dropping W-R1's rename fails (1), with no entry for `feat-b`. Dropping the
 * raise fails (2): C is issued the killed run's id.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	collect,
	runIndexChild,
	spawnIndexChild,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 240_000;
/** Enough new files that the window between the first row and the end is wide. */
const NEW_FILES_IN_B = 300;

interface RegistryBytes {
	nextId: number;
	branches: Array<{ id: number; label: string }>;
}

function parseRegistry(path: string): RegistryBytes {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Branch ids present in `files`, through a connection of this process's own. */
function rowBranchIds(indexDb: string): number[] {
	const db = new Database(indexDb);
	try {
		return (
			db.prepare("SELECT DISTINCT branch_id FROM files").all() as Array<{
				branch_id: number;
			}>
		).map((r) => r.branch_id);
	} finally {
		db.close();
	}
}

describe("V3.20: a branch id's allocation survives a kill, and is never reissued", () => {
	test(
		"(1) the killed run's new label is on disk; (2) a lost allocation's id is not issued again",
		async () => {
			const sb = createGitSandbox("v320-");
			try {
				const store = join(sb.root, "shared-store");
				const main = join(sb.root, "main");
				mkdirSync(main);
				sb.git(main, "init", "-q", "-b", "main");
				writeFileSync(join(main, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeSource(main, "src/base.ts");
				sb.git(main, "add", "-A");
				sb.git(main, "commit", "-q", "-m", "init");
				const scratch = join(sb.root, "scratch");
				const extra = { MNEMEX_INDEX_DIR: store };
				const registryPath = join(store, "branches.json");
				const indexDb = join(store, "index.db");

				// A: index `main` to completion, then snapshot the registry's bytes.
				const a = await runIndexChild("index", main, scratch, main, extra);
				expect(a.exitCode, a.stderr).toBe(0);
				const snapshot = readFileSync(registryPath);
				const snapshotIds = new Set(
					parseRegistry(registryPath).branches.map((b) => b.id),
				);
				expect([...snapshotIds]).toEqual([1]);

				// B: a NEW label, with new files so that it writes rows of its own.
				const b = join(sb.root, "b");
				sb.git(main, "worktree", "add", "-q", "-b", "feat-b", b);
				for (let i = 0; i < NEW_FILES_IN_B; i++)
					writeSource(b, `src/b/f${i}.ts`);

				const child = spawnIndexChild("index", b, scratch, b, extra);
				const collected = collect(child);
				let killedId: number | null = null;
				while (killedId === null && child.exitCode === null) {
					try {
						killedId =
							rowBranchIds(indexDb).find((id) => !snapshotIds.has(id)) ?? null;
					} catch {
						// Mid-write or not yet created: poll again.
					}
					if (killedId !== null) child.kill("SIGKILL");
					else await Bun.sleep(2);
				}
				const run = await collected;
				// The kill landed BEFORE the run finished: no result, killed by the signal.
				expect(killedId).not.toBeNull();
				expect(run.signalCode).toBe("SIGKILL");
				expect(run.result).toBeNull();

				// (1) W-R1: the allocation reached the disk before any row carried it.
				const afterKill = parseRegistry(registryPath);
				const feat = afterKill.branches.find((e) => e.label === "feat-b");
				expect(feat?.id).toBe(killedId as number);
				expect(afterKill.nextId).toBeGreaterThan(killedId as number);

				// (2) The raise: lose the allocation while rows still carry its id…
				writeFileSync(registryPath, snapshot);
				expect(rowBranchIds(indexDb)).toContain(killedId as number);
				// …and index a THIRD new label to completion.
				const c = join(sb.root, "c");
				sb.git(main, "worktree", "add", "-q", "-b", "feat-c", c);
				writeSource(c, "src/c/only-in-c.ts");
				const cRun = await runIndexChild("index", c, scratch, c, extra);
				expect(cRun.exitCode, cRun.stderr).toBe(0);

				const final = parseRegistry(registryPath);
				const featC = final.branches.find((e) => e.label === "feat-c");
				expect(featC).toBeDefined();
				expect(featC?.id).not.toBe(killedId as number);
				expect(featC?.id as number).toBeGreaterThan(killedId as number);
				const ids = final.branches.map((e) => e.id);
				expect(new Set(ids).size).toBe(ids.length);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
