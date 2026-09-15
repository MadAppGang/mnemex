/**
 * V2.11's two halves that were partial in Phase 2, "because the pieces did not
 * exist yet" (`phase-3b-inputs.md` section 4):
 *
 *   THE CLI HALF — `search` and `index`, run as a USER runs them (the built
 *   `dist/index.js`), against a shared `index.db` another process is holding a
 *   write transaction on for longer than the contention budget. The search must
 *   exit NON-ZERO with a named error and print no result rows; the index run
 *   must fail loudly and leave the store's row count untouched. The outcome the
 *   table forbids is exit 0 with zero results — a busy store reported as an
 *   empty one.
 *
 *   THE JOURNAL HALF — after a run is killed mid-write, the next unobstructed
 *   run REPORTS what it recovered, in `--agent` output. Two of the four entry
 *   points that call `index()` render no progress at all, so a notice is not a
 *   channel; the key is.
 *
 * The holder is a raw connection in THIS process, and every row count is read
 * through an INDEPENDENT LanceDB connection.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	collect,
	DIST_ENTRY,
	runCli,
	runIndexChild,
	spawnIndexChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

describe("V2.11 — a contended store fails LOUDLY on the CLI", () => {
	test(
		"search exits non-zero with TrackerContendedError and prints no results; index writes nothing",
		async () => {
			const sb = createGitSandbox("v211-cli-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				for (let i = 0; i < 6; i++) writeSource(project, `src/f${i}.ts`);
				const scratch = join(sb.root, "scratch");
				const store = join(sb.root, "store");
				const extra = { MNEMEX_INDEX_DIR: store };

				const seed = await runIndexChild(
					"index",
					project,
					scratch,
					project,
					extra,
				);
				expect(seed.exitCode, seed.stderr).toBe(0);
				const before = await storeRows(join(store, "vectors"));
				expect(before.length).toBeGreaterThan(0);

				// THE JOURNAL MODE IS PART OF THE FIXTURE, and the reason is
				// measured, not assumed: under WAL a reader does NOT contend with a
				// writer (that is V2.8's property, and `tracker.ts`'s R0 comment
				// records that an already-current `IF NOT EXISTS` schema pass takes
				// no write lock at all under WAL). A first attempt at this test held
				// BEGIN IMMEDIATE over a WAL store and the search returned 10
				// results and exited 0 — correctly. §3.5.3 item 5's ROLLBACK
				// fallback is where readers really do contend, and it is the state
				// this store is put into, exactly as `tracker-concurrency.test.ts`
				// does for the in-process half.
				{
					const reset = createDatabaseSync(join(store, "index.db"));
					reset.prepare("PRAGMA journal_mode = DELETE").get();
					reset.close();
				}

				// A second process holds the store for the whole of both runs
				// below — longer than any region's clamped wait and longer than the
				// per-process contention budget.
				const holder = createDatabaseSync(join(store, "index.db"));
				let search: Awaited<ReturnType<typeof runCli>>;
				let index: Awaited<ReturnType<typeof runCli>>;
				try {
					holder.exec("BEGIN EXCLUSIVE");
					holder
						.prepare(
							"INSERT OR REPLACE INTO metadata (key, value) VALUES ('holder', 'x')",
						)
						.run();
					search = await runCli(
						["search", "function", "--agent"],
						scratch,
						project,
						extra,
					);
					index = await runCli(["index", "--agent"], scratch, project, extra);
				} finally {
					try {
						holder.exec("ROLLBACK");
					} catch {
						// Already ended.
					}
					holder.close();
				}

				// THE OUTCOME THE TABLE FORBIDS is exit 0 with zero results: a
				// busy store answering as an empty one. Both halves asserted.
				console.log(
					`V2.11 search: exit=${search.exitCode} stderr=${search.stderr.trim()}`,
				);
				expect(search.exitCode).not.toBe(0);
				// `TrackerContendedError`'s own message, which is what a user
				// sees. It NAMES the region and says the database is held by
				// another process — the two facts that distinguish "busy" from
				// "empty", which is the whole point of refusing a fallback.
				expect(search.stderr).toContain("tracker region R0");
				expect(search.stderr).toContain(
					"stayed locked by another process past the bounded wait",
				);
				expect(search.stdout).not.toMatch(/^result /m);
				expect(search.stdout).not.toMatch(/^result_count=/m);

				expect(index.exitCode).not.toBe(0);
				// And it wrote NOTHING: the row count through an independent
				// connection is exactly what the seeding run left.
				const after = await storeRows(join(store, "vectors"));
				expect(after.length).toBe(before.length);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the journal half: a killed run's residue is REPORTED by the next `index --agent`",
		async () => {
			const sb = createGitSandbox("v211-journal-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				for (let i = 0; i < 60; i++) writeSource(project, `src/f${i}.ts`, 4);
				const scratch = join(sb.root, "scratch");
				const store = join(sb.root, "store");
				const extra = { MNEMEX_INDEX_DIR: store };
				const lockPath = join(store, ".indexing.lock");

				// Kill mid-append, so `'add'` intents survive.
				const child = spawnIndexChild(
					"index",
					project,
					scratch,
					project,
					extra,
				);
				const collected = collect(child);
				let killed = false;
				while (!killed && child.exitCode === null) {
					if (existsSync(lockPath)) {
						try {
							const phase = (
								JSON.parse(await Bun.file(lockPath).text()) as {
									phase?: string;
								}
							).phase;
							if (phase === "writing:lance") {
								child.kill("SIGKILL");
								killed = true;
							}
						} catch {
							// Mid-write: poll again.
						}
					}
					if (!killed) await Bun.sleep(1);
				}
				await collected;
				expect(killed).toBe(true);

				const recover = await runCli(
					["index", "--agent"],
					scratch,
					project,
					extra,
				);
				expect(recover.exitCode, recover.stderr).toBe(0);
				// DATA, not a notice. The git post-commit hook and the MCP
				// auto-reindex pass no progress callback at all, so a rendered
				// line reaches neither of them.
				const added = /^recovered_crash_residue_added=(\d+)$/m.exec(
					recover.stdout,
				);
				expect(added).not.toBeNull();
				expect(Number(added?.[1])).toBeGreaterThan(0);
				// And the branch keys are present on every run, so a consumer can
				// rely on them rather than on their absence.
				expect(recover.stdout).toMatch(/^branch_widen_remaining=0$/m);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test("the CLI under test is the BUILT entry point", () => {
		// `bun run build` is a precondition of this suite (CLAUDE.md #13). A
		// missing bundle would make every assertion above vacuous.
		expect(existsSync(DIST_ENTRY)).toBe(true);
	});
});
