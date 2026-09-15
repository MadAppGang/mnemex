/**
 * Upgrading a v3 store to index version 4 (architecture §3.5.1, §6.1, §6.3),
 * one test per V4 criterion. Every one reads the store afterwards through
 * connections of its own.
 *
 *   V4.1  `index --agent`: `upgraded_from_index_version=3`, then absent on the
 *         next run. `abandoned_store_dir` is ABSENT in this phase: §6.1 sets it
 *         only when the probed dir differs from storeDir, and until 3c they are
 *         one directory. (The `abandoned_store_dir=<old>` half is 3c's.)
 *   V4.2  the same fact through the RESULT OBJECT, `onProgress` undefined.
 *   V4.5  after the run, an independent connection sees `branch_id` in
 *         `files`, and `(1,'a.ts')` and `(2,'a.ts')` coexist.
 *   V4.6  a fresh clone: `upgraded_from_index_version` is absent.
 *   V4.7  in ONE process: `initialize()` (records the tracker's schema memo),
 *         then `rebuildStore()`. The same connection sees the v4 `files`.
 *   V4.8  the version comes from the old store's own stamp: 3 when it says 3,
 *         ABSENT (never 1) when it says nothing. The rebuild happens either way.
 *
 * V4.3 (no embedding requests across the rebuild) needs a provider to count,
 * so it lives with the e2e suite (`test/e2e/index-v4-paths-e2e.test.ts`). V4.4
 * is a store-level fixture (`store-v4-schema.test.ts`).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	runIndexChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 180_000;

/** What an index-v3 build left in `<project>/.mnemex`. */
async function makeV3Store(
	project: string,
	legacyStamp: number | null,
): Promise<void> {
	const storeDir = join(project, ".mnemex");
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(
		join(storeDir, "config.json"),
		JSON.stringify(legacyStamp === null ? {} : { indexVersion: legacyStamp }),
	);

	const db = new Database(join(storeDir, "index.db"));
	try {
		db.exec(
			`CREATE TABLE files (
				path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, mtime REAL NOT NULL,
				chunk_ids TEXT NOT NULL, indexed_at TEXT NOT NULL,
				enrichment_state TEXT DEFAULT '{}', enriched_at TEXT, indexed_at_commit TEXT
			)`,
		);
		db.prepare(
			"INSERT INTO files (path, content_hash, mtime, chunk_ids, indexed_at) VALUES (?, 'stale', 1, '[\"old\"]', 't')",
		).run("src/a.ts");
	} finally {
		db.close();
	}

	// 23 inferred columns and an ABSOLUTE path, as v3 wrote them.
	const vectors = await lancedb.connect(join(storeDir, "vectors"));
	const row: Record<string, unknown> = {
		id: "old",
		contentHash: "",
		content: "function old() {}",
		filePath: join(project, "src", "a.ts"),
		startLine: 1,
		endLine: 1,
		language: "typescript",
		chunkType: "function",
		name: "old",
		parentName: "",
		signature: "",
		fileHash: "",
		vector: [0],
		embedKey: "",
		documentType: "code_chunk",
		sourceIds: "[]",
		metadata: "{}",
		createdAt: "",
		enrichedAt: "",
		parentId: "",
		unitType: "",
		depth: -1,
		summary: "",
	};
	await vectors.createTable("code_chunks", [row], { mode: "create" });
}

function makeProject(sb: GitSandbox, name: string): string {
	const project = join(sb.root, name);
	mkdirSync(project);
	writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
	writeSource(project, "src/a.ts");
	writeSource(project, "src/b.ts");
	return project;
}

function filesColumns(project: string): string[] {
	const db = new Database(join(project, ".mnemex", "index.db"));
	try {
		return (
			db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>
		).map((c) => c.name);
	} finally {
		db.close();
	}
}

async function assertUpgradedStore(project: string): Promise<void> {
	expect(filesColumns(project)).toContain("branch_id");
	const rows = await storeRows(join(project, ".mnemex", "vectors"));
	expect(rows.length).toBeGreaterThan(0);
	expect(rows.some((r) => r.id === "old")).toBe(false);
	expect(
		rows.every((r) => r.pathKind === "repo" && r.branchIds === ",0,"),
	).toBe(true);
	// The store lands on the CURRENT version, which is 5 since I-14 — the v3
	// fixture's upgrade is one rebuild to today, not a stop at 4.
	expect(
		JSON.parse(readFileSync(join(project, ".mnemex", "store.json"), "utf8"))
			.indexVersion,
	).toBe(5);
}

describe("V4.1: the upgrade is reported by `index --agent`, once", () => {
	test(
		"upgraded_from_index_version=3 then absent; abandoned_store_dir absent while the store is per-worktree",
		async () => {
			const sb = createGitSandbox("v41-");
			try {
				const project = makeProject(sb, "project");
				await makeV3Store(project, 3);
				const legacyConfig = readFileSync(
					join(project, ".mnemex", "config.json"),
					"utf8",
				);
				const scratch = join(sb.root, "scratch");

				const first = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				expect(first.stdout).toMatch(/^upgraded_from_index_version=3$/m);
				expect(first.stdout).not.toContain("abandoned_store_dir");
				await assertUpgradedStore(project);
				// The legacy stamp is ignored, not migrated and not deleted (§3.6).
				expect(
					readFileSync(join(project, ".mnemex", "config.json"), "utf8"),
				).toBe(legacyConfig);

				const second = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
				);
				expect(second.exitCode, second.stderr).toBe(0);
				expect(second.stdout).not.toContain("upgraded_from_index_version");
				expect(second.stdout).not.toContain("abandoned_store_dir");
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V4.2 and V4.8: the result object carries the old store's OWN version, or nothing", () => {
	test(
		"a v3 stamp: upgradedFromIndexVersion 3 with onProgress undefined, then absent",
		async () => {
			const sb = createGitSandbox("v42-");
			try {
				const project = makeProject(sb, "project");
				await makeV3Store(project, 3);
				const scratch = join(sb.root, "scratch");

				const first = await runIndexChild("index", project, scratch, sb.root);
				expect(first.exitCode, first.stderr).toBe(0);
				expect(first.result?.hasUpgradedField).toBe(true);
				expect(first.result?.upgradedFromIndexVersion).toBe(3);
				await assertUpgradedStore(project);

				const second = await runIndexChild("index", project, scratch, sb.root);
				expect(second.exitCode, second.stderr).toBe(0);
				expect(second.result?.hasUpgradedField).toBe(false);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"no stamp at all: the field is ABSENT, never 1, and the store is rebuilt anyway",
		async () => {
			const sb = createGitSandbox("v48-");
			try {
				const project = makeProject(sb, "project");
				await makeV3Store(project, null);
				const scratch = join(sb.root, "scratch");

				const run = await runIndexChild("index", project, scratch, sb.root);
				expect(run.exitCode, run.stderr).toBe(0);
				expect(run.result?.hasUpgradedField).toBe(false);
				expect(run.result?.upgradedFromIndexVersion).toBeNull();
				// The tracker and LanceDB signals still caught it (§6.1).
				await assertUpgradedStore(project);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("§6.1's `=== false`: a store with no LanceDB table is fresh, not outdated", () => {
	/**
	 * `hasBranchIdsColumn()` answers `null` when there is no table. Read with
	 * truthiness instead of `=== false`, that null would rebuild a table-less
	 * store on every run, forever, and report an upgrade each time.
	 */
	test(
		"a store that never had a table is not rebuilt, and reports nothing, on its next run",
		async () => {
			const sb = createGitSandbox("v4-null-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(join(project, ".mnemex"), { recursive: true });
				// Settings inside the store dir, which discovery skips, and nothing a
				// parser takes: no row is written, so no table is ever created.
				writeFileSync(
					join(project, ".mnemex", "config.json"),
					JSON.stringify(BM25_ONLY),
				);
				writeFileSync(
					join(project, "notes.unindexable"),
					"nothing a parser takes",
				);
				const scratch = join(sb.root, "scratch");

				const first = await runIndexChild("index", project, scratch, sb.root);
				expect(first.exitCode, first.stderr).toBe(0);
				expect(first.result?.hasUpgradedField).toBe(false);
				expect(await storeRows(join(project, ".mnemex", "vectors"))).toEqual(
					[],
				);

				const second = await runIndexChild("index", project, scratch, sb.root);
				expect(second.exitCode, second.stderr).toBe(0);
				expect(second.result?.hasUpgradedField).toBe(false);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V4.5: the upgraded tracker has the v4 key, through an independent connection", () => {
	test(
		"branch_id is listed, and (1,'a.ts') and (2,'a.ts') coexist",
		async () => {
			const sb = createGitSandbox("v45-");
			try {
				const project = makeProject(sb, "project");
				await makeV3Store(project, 3);
				const scratch = join(sb.root, "scratch");
				const run = await runIndexChild("index", project, scratch, sb.root);
				expect(run.exitCode, run.stderr).toBe(0);

				expect(filesColumns(project)).toContain("branch_id");
				const db = new Database(join(project, ".mnemex", "index.db"));
				try {
					const insert = db.prepare(
						"INSERT INTO files (branch_id, path, content_hash, mtime, chunk_ids, indexed_at) VALUES (?, 'a.ts', 'h', 1, '[]', 't')",
					);
					insert.run(1);
					insert.run(2);
					expect(
						db
							.prepare(
								"SELECT branch_id FROM files WHERE path = 'a.ts' ORDER BY branch_id",
							)
							.all(),
					).toEqual([{ branch_id: 1 }, { branch_id: 2 }]);
				} finally {
					db.close();
				}
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V4.6: a fresh clone reports no upgrade", () => {
	test(
		"`index --agent` in a clone with no store prints no upgraded_from_index_version",
		async () => {
			const sb = createGitSandbox("v46-");
			try {
				const origin = makeProject(sb, "origin");
				sb.git(origin, "init", "-q");
				sb.git(origin, "add", "-A");
				sb.git(origin, "commit", "-q", "-m", "init");
				const clone = join(sb.root, "clone");
				sb.git(sb.root, "clone", "-q", origin, clone);
				const scratch = join(sb.root, "scratch");

				const run = await runCli(
					["index", "--agent", "--no-llm", clone],
					scratch,
					clone,
				);
				expect(run.exitCode, run.stderr).toBe(0);
				// It did index (the fixture's mnemex.json is indexed as well as src/).
				expect(
					Number(/^indexed_files=(\d+)$/m.exec(run.stdout)?.[1]),
				).toBeGreaterThan(0);
				expect(run.stdout).not.toContain("upgraded_from_index_version");
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V4.7: the rebuild does not trust the per-process schema memo", () => {
	test(
		"initialize() then rebuildStore(), in one process: the SAME connection sees the v4 files",
		async () => {
			const sb = createGitSandbox("v47-");
			try {
				const project = makeProject(sb, "project");
				await makeV3Store(project, 3);
				const scratch = join(sb.root, "scratch");

				const run = await runIndexChild(
					"rebuild-memo",
					project,
					scratch,
					sb.root,
				);
				expect(run.exitCode, run.stderr).toBe(0);
				expect(run.result?.columns).toContain("branch_id");
				expect(run.result?.first).toBe("ok");
				expect(run.result?.second).toBe("ok");
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
