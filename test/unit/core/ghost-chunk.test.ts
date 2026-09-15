/**
 * The ghost-chunk regression (architecture §4.2, findings
 * deleted-files-leave-ghost-chunks.md).
 *
 * Before index version 4, `deleteByFile(<tracker path>)` compared a RELATIVE
 * path against a column of ABSOLUTE ones and matched zero rows, while the
 * tracker row was dropped anyway. The chunks of every deleted file stayed
 * searchable forever. Measured: 80 rows in, 80 rows still there. A second road
 * led to the same place: `getChunkIds(relativePath)` resolved its argument
 * against the process cwd, so from any cwd but the project root the delete was
 * skipped altogether. So these runs are launched from ANOTHER directory.
 *
 * The count is read through an INDEPENDENT LanceDB connection, never from a
 * return value. The zero-row warning the previous commit added must stay
 * silent for a real deletion.
 *
 * FALSIFIED (recorded in the implementation log) by restoring the absolute
 * convention on ONE side only: the vector store writing `filePath` absolute
 * while the tracker keeps the stored form. The deleted file's rows then
 * survive, and the warning fires.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runIndexChild,
	storeRows,
	writeSource,
	ZERO_ROW_DELETE_WARNING,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 180_000;

describe.each([
	["a plain directory", false],
	["a git repository", true],
] as const)("ghost chunks (§4.2), in %s", (_shape, isGit) => {
	test(
		"a deleted file's rows are gone after the re-index, counted independently, and no zero-row warning fires",
		async () => {
			const sb = createGitSandbox("ghost-chunk-");
			try {
				const project = join(sb.root, "project");
				const elsewhere = join(sb.root, "elsewhere");
				mkdirSync(project);
				mkdirSync(elsewhere);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeSource(project, "src/keep.ts");
				writeSource(project, "src/gone.ts");
				if (isGit) {
					sb.git(project, "init", "-q");
					sb.git(project, "add", "-A");
					sb.git(project, "commit", "-q", "-m", "init");
				}
				const scratch = join(sb.root, "scratch");
				const vectors = join(project, ".mnemex", "vectors");

				const first = await runIndexChild("index", project, scratch, elsewhere);
				expect(first.exitCode, first.stderr).toBe(0);

				const before = await storeRows(vectors);
				// A file's rows, counted by path SUFFIX. The deletion assertions below
				// must not depend on the stored-path convention they exist to test:
				// under the one-sided falsifier the rows are stored absolute, and a
				// count by the relative string would see none of them.
				const rowsOf = (rows: Array<Record<string, unknown>>, rel: string) =>
					rows.filter((r) => {
						const path = String(r.filePath);
						return path === rel || path.endsWith(`/${rel}`);
					});
				const keepBefore = rowsOf(before, "src/keep.ts");
				expect(rowsOf(before, "src/gone.ts").length).toBeGreaterThan(0);
				expect(keepBefore.length).toBeGreaterThan(0);

				rmSync(join(project, "src", "gone.ts"));
				const second = await runIndexChild(
					"index",
					project,
					scratch,
					elsewhere,
				);
				expect(second.exitCode, second.stderr).toBe(0);

				const after = await storeRows(vectors);
				// ONE assertion over both facts, so a failure shows both: the deleted
				// file's rows (independent count) and whether the zero-row warning fired.
				expect({
					deletedFileRows: rowsOf(after, "src/gone.ts").length,
					zeroRowWarning: second.stderr.includes(ZERO_ROW_DELETE_WARNING),
				}).toEqual({ deletedFileRows: 0, zeroRowWarning: false });
				expect(rowsOf(after, "src/keep.ts").length).toBe(keepBefore.length);

				// The convention itself: every row stored relative, as a repo path,
				// under ONE real id (0 without a git layout, the registry's first id
				// inside one).
				const branchIds = isGit ? ",1," : ",0,";
				for (const row of before) {
					expect(isAbsolute(String(row.filePath))).toBe(false);
					expect(row.pathKind).toBe("repo");
					expect(row.branchIds).toBe(branchIds);
				}
				if (isGit) {
					const registry = JSON.parse(
						readFileSync(join(project, ".mnemex", "branches.json"), "utf8"),
					);
					expect(registry.branches.map((b: { id: number }) => b.id)).toEqual([
						1,
					]);
				}

				// The tracker agrees, read through its own independent connection.
				const db = new Database(join(project, ".mnemex", "index.db"));
				try {
					const tracked = (
						db.prepare("SELECT path FROM files").all() as Array<{
							path: string;
						}>
					).map((r) => r.path);
					// The fixture's own mnemex.json is indexed too; it is not the point.
					expect(tracked).toContain("src/keep.ts");
					expect(tracked).not.toContain("src/gone.ts");
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
