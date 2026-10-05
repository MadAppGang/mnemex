/**
 * The dirty overlay's tracker reads (step 3, R3): what the INDEX holds for a
 * path, and what was indexed since a high-water mark.
 *
 *   getIndexedFileStates(branchIds, paths)  — classification. Every row in the
 *     branch set for each path, under BOTH Unicode spellings (git on macOS
 *     reports NFC; a stored path came from `readdirSync` and can be NFD), so a
 *     file is never classified "unindexed" because two spellings of one name
 *     differ. Each answer carries the TRACKER's spelling: that is what the
 *     overlay suppresses and writes. ≤ 64 paths per call — one bounded region
 *     (CLAUDE.md #31); the caller yields between calls.
 *   getFilesIndexedSince(branchId, after, limit) — the `T` set, keyset-paged on
 *     `(indexed_at, path)` so a page boundary inside one batch's timestamp
 *     neither skips nor repeats a row.
 *   getIndexedHighWater(branchId) — the first pass's starting mark.
 *
 * Every statement names `branch_id` (V3.11b; the body sweep is extended in
 * `tracker-branch-sweep.test.ts`, G-1). Asserted here on DATA: another
 * branch's row is never returned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileTracker,
	type IFileTracker,
	INDEXED_STATES_MAX_PATHS,
} from "../../../src/core/tracker.js";

let dir: string;
let tracker: IFileTracker;

const NFC = "src/café.ts";
const NFD = "src/café.ts";

beforeAll(() => {
	dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-trk-reads-")));
	tracker = createFileTracker(join(dir, "index.db"), dir);
	tracker.markIndexed(1, "src/a.ts", "hash-a-1", ["c1"]);
	tracker.markIndexed(2, "src/a.ts", "hash-a-2", ["c2"]);
	tracker.markIndexed(3, "src/a.ts", "hash-a-3", ["c3"]);
	tracker.markIndexed(1, NFD, "hash-cafe", ["c4"]);
	tracker.markIndexed(2, "src/only-two.ts", "hash-two", ["c5"]);
});

afterAll(() => {
	(tracker as unknown as { close(): void }).close();
	rmSync(dir, { recursive: true, force: true });
});

describe("getIndexedFileStates", () => {
	test("branch scope: only that branch's rows, never another's (A)", () => {
		const states = tracker.getIndexedFileStates(
			[1],
			["src/a.ts", "src/only-two.ts", "src/absent.ts"],
		);
		expect(states.get("src/a.ts")).toEqual([
			{ path: "src/a.ts", contentHash: "hash-a-1" },
		]);
		expect(states.get("src/only-two.ts")).toEqual([]);
		expect(states.get("src/absent.ts")).toEqual([]);
	});

	test("a branch SET (SCOPE_ALL's registry snapshot) returns each row once", () => {
		const states = tracker.getIndexedFileStates([1, 2], ["src/a.ts"]);
		const rows = states.get("src/a.ts") ?? [];
		expect(rows.map((r) => r.contentHash).sort()).toEqual([
			"hash-a-1",
			"hash-a-2",
		]);
	});

	test("an NFC query finds an NFD row, answered in the TRACKER's spelling", () => {
		const states = tracker.getIndexedFileStates([1], [NFC]);
		expect(states.get(NFC)).toEqual([{ path: NFD, contentHash: "hash-cafe" }]);
	});

	test("more than one region's worth of paths is refused, not silently split", () => {
		const paths = Array.from(
			{ length: INDEXED_STATES_MAX_PATHS + 1 },
			(_, i) => `p${i}.ts`,
		);
		expect(() => tracker.getIndexedFileStates([1], paths)).toThrow(RangeError);
		expect(INDEXED_STATES_MAX_PATHS).toBe(64);
	});

	test("empty inputs answer without a statement", () => {
		expect(tracker.getIndexedFileStates([1], []).size).toBe(0);
		expect(
			tracker.getIndexedFileStates([], ["src/a.ts"]).get("src/a.ts"),
		).toEqual([]);
	});
});

describe("getFilesIndexedSince / getIndexedHighWater", () => {
	test("keyset paging walks every row of the branch once, in (indexed_at, path) order", () => {
		const local = createFileTracker(join(dir, "paging.db"), dir);
		try {
			for (let i = 0; i < 9; i++) {
				local.markIndexed(5, `src/f${i}.ts`, `h${i}`, [`x${i}`]);
			}
			local.markIndexed(6, "src/other-branch.ts", "h", ["y"]);
			const seen: string[] = [];
			let after: { indexedAt: string; path: string } | null = null;
			for (let guard = 0; guard < 20; guard++) {
				const page = local.getFilesIndexedSince(5, after, 4);
				if (page.length === 0) break;
				seen.push(...page.map((r) => r.path));
				const last = page[page.length - 1];
				after = { indexedAt: last.indexedAt, path: last.path };
			}
			expect(seen.sort()).toEqual(
				Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`).sort(),
			);
			expect(new Set(seen).size).toBe(9);

			const high = local.getIndexedHighWater(5);
			expect(high).not.toBeNull();
			// Nothing is indexed after the high-water mark…
			expect(local.getFilesIndexedSince(5, high, 4)).toEqual([]);
			// …until something is.
			local.markIndexed(5, "src/zz-late.ts", "late", ["z"]);
			expect(local.getFilesIndexedSince(5, high, 4).map((r) => r.path)).toEqual(
				["src/zz-late.ts"],
			);
			expect(local.getIndexedHighWater(99)).toBeNull();
		} finally {
			(local as unknown as { close(): void }).close();
		}
	});
});
