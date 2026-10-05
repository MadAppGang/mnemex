/**
 * `prepareDirtyOverlay` — the named sets and the cost (step 3, R3; phase 4).
 *
 * Real git, a real tracker, real LanceDB, real `chunkFileByPath`, the real
 * embed cache at a temp path; the "provider" is a counting stub, so every
 * claim about embedding cost is a COUNT of texts that reached it.
 *
 *   SET-1  git-dirty but index-current → no suppression, no overlay rows (HIGH 8)
 *   D-2    edit one of two dirty files → only its changed chunks are embedded,
 *          only it is rebuilt, `clear()` never called (R3.4)
 *   C-2    a warm cache from the index → 0 provider calls for unchanged chunks (R3.5)
 *   C-3    no sandboxed cache path → the user-path refusal THROWS (#31)
 *   I-1    the provider refuses AFTER the query embedded → skipped/embed-failed,
 *          nothing suppressed (R3.11, re-scoped by ruling 1)
 *   Q-1    1 ms budget → pending, nothing of it suppressed; the budget is checked
 *          BETWEEN batches of one large file; the next pass completes
 *   BIG-1  over the size cap → failed(too-large), index rows visible
 *   CUR-1  tracker (mtime after edit, hash before edit) → still stale, served (HIGH 3)
 *   MEMO-1 the hash memo is not recorded for a racy mtime or a moving file
 *   SP-1   NFD-indexed path, NFC from git → the TRACKER's spelling, once
 *   W-1    seen dirty, restored to HEAD, index still holds the dirty text → W keeps it
 *   W-2    untracked → served → committed with NO reindex → STILL served, `dirty`,
 *          kept in W; a reindex then drops it (review 1, HIGH 2)
 *   CAP-1  W full of files a reindex made index-current never locks the pass out
 *          as `too-large` (review 1, MEDIUM 4)
 *   CAP-2  T never takes in more than `watch` can keep: a stale tracker-only file
 *          is not lost to truncation while the mark moves past it (MEDIUM 5)
 *   ZC-1   a committed file the REAL indexer gives zero chunks (and so no tracker
 *          row) is index-current: a clean worktree is `index-current` again,
 *          with no candidates and an empty watch (code review 2, MEDIUM 2)
 *   CAP-3  T rows already in C cost no watch capacity: the mark advances and
 *          no "unclassified" gap is reported (code review 2, LOW 8)
 *   HW-1   indexed after the manifest existed, git-clean → T finds it
 *   MOD-1  manifest identity = the index's; a manifest built with another model is wiped
 *   EC-1   an index lock held in-process + a cold cache memo → no full open, skipped
 *   L-1    a pass in one worktree writes nothing in another's overlay
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createCachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import { chunkFileByPath } from "../../../src/core/chunker.js";
import * as embedCache from "../../../src/core/embed-cache.js";
import {
	openEmbedCache,
	USER_PATH_REFUSAL_PREFIX,
} from "../../../src/core/embed-cache.js";
import { createStoreLock } from "../../../src/core/lock.js";
import {
	type DirtyOverlayResult,
	prepareDirtyOverlay,
} from "../../../src/core/overlay/dirty-overlay.js";
import { VectorStore } from "../../../src/core/store.js";
import {
	getDirtyOverlayDirFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { computeFileHash, hashFileBytes } from "../../../src/core/tracker.js";
import { overlayHeaderLines } from "../../../src/output/agent.js";
import {
	BRANCH,
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	StubEmbedder,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";

let fx: OverlayFixture | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	fx?.cleanup();
	fx = null;
});

async function fixture(files: Record<string, string>): Promise<OverlayFixture> {
	fx = await createOverlayFixture(files);
	indexAll(fx, Object.keys(files));
	return fx;
}

function rowPaths(rows: Array<Record<string, unknown>>): string[] {
	return [...new Set(rows.map((r) => String(r.filePath)))].sort();
}

function servedPaths(result: DirtyOverlayResult): string[] {
	return [...(result.candidates?.servedPaths ?? [])];
}

describe("the named sets", () => {
	test("clean worktree: on/index-current, NO candidates (NFR-2's path)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.state).toBe("on");
		expect(result.report.reason).toBe("index-current");
		expect(result.candidates).toBeUndefined();
		expect(f.stub.texts).toBe(0);
	});

	test("modified, untracked and deleted: served, served, suppressed (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/gone.ts": tsSource("gone", 1),
			"src/clean.ts": tsSource("clean", 1),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.write("src/new.ts", tsSource("fresh", 2));
		f.remove("src/gone.ts");
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 2,
			filesDeleted: 1,
			filesFailed: 0,
			filesPending: 0,
		});
		expect(servedPaths(result)).toEqual(["src/a.ts", "src/new.ts"]);
		expect(result.candidates?.suppressedPaths).toEqual([
			"src/a.ts",
			"src/gone.ts",
			"src/new.ts",
		]);
		// The rows read are the EDITED text, and only served files' rows.
		const vector = result.candidates?.vector ?? [];
		expect(vector.length).toBeGreaterThan(0);
		expect(vector.every((r) => r.filePath !== "src/clean.ts")).toBe(true);
		const contents = [...(result.candidates?.rowsById.values() ?? [])]
			.filter((r) => r.filePath === "src/a.ts")
			.map((r) => r.content)
			.join("\n");
		expect(contents).toContain("edited");
		expect(rowPaths(await f.overlayRows())).toEqual(["src/a.ts", "src/new.ts"]);
	});

	test("SET-1: git-dirty but index-current → not suppressed, no overlay rows (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.index("src/a.ts"); // the index caught up with the edit; git still says dirty
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.filesIndexCurrent).toBe(1);
		expect(result.candidates).toBeUndefined();
		expect(await f.overlayRows()).toEqual([]);
		expect(f.stub.texts).toBe(0);
	});

	test("C-1: indexed-after-edit is indexCurrent; a NON-UTF-8 file hashes as the tracker does (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		// Latin-1 bytes: a UTF-8 decode is lossy, so a hash over decoded text
		// would never equal the tracker's hash of the bytes.
		const latin1 = Buffer.concat([
			Buffer.from("export const caf = '"),
			Buffer.from([0x63, 0x61, 0x66, 0xe9]),
			Buffer.from("';\n"),
		]);
		fs.writeFileSync(join(f.repo, "src/latin1.ts"), latin1);
		// The tracker's own hash function, over the file as indexed.
		f.tracker.markIndexed(
			BRANCH,
			"src/a.ts",
			computeFileHash(join(f.repo, "src/a.ts")),
			[],
		);
		f.tracker.markIndexed(
			BRANCH,
			"src/latin1.ts",
			computeFileHash(join(f.repo, "src/latin1.ts")),
			[],
		);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.filesIndexCurrent).toBe(2);
		expect(result.candidates).toBeUndefined();
		expect(f.stub.texts).toBe(0);
	});

	test("CUR-1: a tracker row stamped after the edit with the OLD hash is still stale (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		const oldHash = hashFileBytes(f.read("src/a.ts"));
		f.write("src/a.ts", tsSource("a", 2, "saved-during-index"));
		// The indexer's mtime stamp (taken after embedding) with the old hash.
		f.index("src/a.ts", oldHash);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(result)).toEqual(["src/a.ts"]);
		expect(result.candidates?.suppressedPaths).toEqual(["src/a.ts"]);
	});

	test("SP-1: an NFD-indexed file git reports NFC → the tracker's spelling, once (A)", async () => {
		const nfd = "src/café.ts";
		const nfc = "src/café.ts";
		const f = await fixture({ [nfd]: tsSource("cafe", 2) });
		// The tracker holds the NFD spelling (as readdirSync gave it).
		f.tracker.removeFile(BRANCH, nfc);
		f.index(nfd);
		f.write(nfd, tsSource("cafe", 2, "edited"));
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.candidates?.servedPaths).toEqual([nfd]);
		expect(result.candidates?.suppressedPaths).toEqual([nfd]);
		expect(rowPaths(await f.overlayRows())).toEqual([nfd]);
	});
});

describe("cost", () => {
	test("D-2: edit one of two dirty files → only its changed chunks, only it rebuilt, no clear() (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 4),
			"src/b.ts": tsSource("b", 4),
		});
		f.write("src/a.ts", tsSource("a", 4, "v1"));
		f.write("src/b.ts", tsSource("b", 4, "v1"));
		const clear = spyOn(VectorStore.prototype, "clear");
		spies.push(clear);

		const first = await prepareDirtyOverlay(f.ctx());
		expect(first.report.rebuilt).toBe(2);
		const bIdsBefore = (await f.overlayRows())
			.filter((r) => r.filePath === "src/b.ts")
			.map((r) => r.id)
			.sort();

		// Edit ONE function of a.ts.
		const edited = tsSource("a", 4, "v1").replace(
			"a function 2 v1",
			"a function 2 v2",
		);
		f.write("src/a.ts", edited);
		f.stub.calls.length = 0;
		const second = await prepareDirtyOverlay(f.ctx());
		expect(second.report.rebuilt).toBe(1);
		// Exactly the chunk whose text changed reached the provider.
		expect(f.stub.texts).toBe(1);
		expect(f.stub.calls.flat()[0]).toContain("a function 2 v2");
		const bIdsAfter = (await f.overlayRows())
			.filter((r) => r.filePath === "src/b.ts")
			.map((r) => r.id)
			.sort();
		expect(bIdsAfter).toEqual(bIdsBefore);
		expect(clear).not.toHaveBeenCalled();
	});

	test("C-2: a cache warmed by the INDEX → 0 provider calls for unchanged chunks (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 5) });
		// Warm the machine-global cache the way `Indexer.index()` does: the
		// same model, dimension and texts, through the same caching seam.
		const indexed = await chunkFileByPath(
			f.read("src/a.ts").toString("utf8"),
			"src/a.ts",
			"h",
		);
		const warmer = createCachingEmbeddingsClient(new StubEmbedder(), {
			cache: openEmbedCache(f.embedCachePath),
			clientFingerprint: "",
		});
		await warmer.embedContentOf(indexed, "chunks");

		const edited = tsSource("a", 5).replace(
			"a function 3 ",
			"a function 3 EDIT",
		);
		f.write("src/a.ts", edited);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(result)).toEqual(["src/a.ts"]);
		expect(f.stub.texts).toBe(1);
		expect(result.report.cacheHits).toBeGreaterThanOrEqual(4);
		expect(result.report.embedded).toBe(1);
	});

	test("C-3: no sandboxed cache path → the user-path refusal THROWS (not a skip)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		const prev = process.env.MNEMEX_EMBED_CACHE_PATH;
		delete process.env.MNEMEX_EMBED_CACHE_PATH;
		try {
			await expect(
				prepareDirtyOverlay(f.ctx({ embedCachePath: undefined })),
			).rejects.toThrow(USER_PATH_REFUSAL_PREFIX);
		} finally {
			if (prev !== undefined) process.env.MNEMEX_EMBED_CACHE_PATH = prev;
		}
	});

	test("I-1: the provider refuses AFTER the query → skipped/embed-failed, nothing suppressed (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/gone.ts": tsSource("gone", 1),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.remove("src/gone.ts");
		// The query vector already exists (ctx.queryVector); every overlay call fails.
		f.stub.failAfter = 0;
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.state).toBe("skipped");
		expect(result.report.reason).toBe("embed-failed");
		// Index rows stay visible: no candidates at all, so nothing is suppressed.
		expect(result.candidates).toBeUndefined();
		expect(await f.overlayRows()).toEqual([]);
	});

	test("Q-1: 1 ms budget → pending, unsuppressed; checked BETWEEN batches of one file; next pass completes (A)", async () => {
		const f = await fixture({
			"src/big.ts": tsSource("big", 150),
			"src/small.ts": tsSource("small", 2),
		});
		f.write("src/big.ts", tsSource("big", 150, "edited"));
		f.write("src/small.ts", tsSource("small", 2, "edited"));
		f.stub.beforeEmbed = () => Bun.sleep(3);
		const first = await prepareDirtyOverlay(
			f.ctx({ limits: { rebuildBudgetMs: 1 } }),
		);
		expect(first.report.filesPending).toBeGreaterThan(0);
		// One batch of the 150-chunk file reached the provider, not all three.
		expect(f.stub.calls.length).toBe(1);
		expect(f.stub.calls[0].length).toBe(64);
		// Pending files are neither served nor suppressed.
		expect(first.candidates?.suppressedPaths ?? []).not.toContain("src/big.ts");

		const second = await prepareDirtyOverlay(f.ctx());
		expect(second.report.filesPending).toBe(0);
		expect(servedPaths(second)).toEqual(["src/big.ts", "src/small.ts"]);
		// The first pass's batch was cached: no text reached the provider twice.
		expect(second.report.cacheHits).toBe(64);
		const sent = f.stub.calls.flat();
		expect(new Set(sent).size).toBe(sent.length);
	});

	test("BIG-1: a file over the cap → failed(too-large), not suppressed (A)", async () => {
		const f = await fixture({ "src/big.ts": tsSource("big", 3) });
		f.write("src/big.ts", tsSource("big", 3, "edited"));
		const result = await prepareDirtyOverlay(
			f.ctx({ limits: { maxFileBytes: 100 } }),
		);
		expect(result.report.filesFailed).toBe(1);
		expect(result.report.gaps).toContain("file-failed-too-large");
		expect(result.report.gapDetails).toContainEqual(
			expect.objectContaining({
				token: "file-failed-too-large",
				path: "src/big.ts",
			}),
		);
		expect(result.candidates).toBeUndefined();
		expect(f.stub.texts).toBe(0);
	});
});

describe("the hash memo (MEMO-1)", () => {
	test("a racy (< 2 s old) mtime is not memoised; an old one is, and is reused", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await prepareDirtyOverlay(f.ctx());
		expect(f.manifest()?.hashMemo["src/a.ts"]).toBeUndefined();

		const old = new Date(Date.now() - 10_000);
		utimesSync(join(f.repo, "src/a.ts"), old, old);
		await prepareDirtyOverlay(f.ctx());
		const entry = f.manifest()?.hashMemo["src/a.ts"];
		expect(entry?.hash).toBe(hashFileBytes(f.read("src/a.ts")));

		// Reused: the classification does not read the file again.
		const reads = spyOn(fs, "readFileSync");
		spies.push(reads);
		await prepareDirtyOverlay(f.ctx());
		const aReads = reads.mock.calls.filter((c) =>
			String(c[0]).endsWith("src/a.ts"),
		);
		expect(aReads).toHaveLength(0);
	});

	test("a file that changed DURING the read is not memoised", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		const old = new Date(Date.now() - 10_000);
		utimesSync(join(f.repo, "src/a.ts"), old, old);
		const original = fs.readFileSync;
		let injected = false;
		const reads = spyOn(fs, "readFileSync").mockImplementation(((
			path: fs.PathOrFileDescriptor,
			options?: unknown,
		) => {
			const value = (original as (p: unknown, o?: unknown) => unknown)(
				path,
				options,
			);
			if (!injected && String(path).endsWith("src/a.ts")) {
				injected = true;
				// A save lands right after our read: the post-read stat differs.
				// Its mtime is set OLD again, so the racy-window guard cannot be
				// what refuses the memo — only the pre/post stat comparison can.
				const target = join(f.repo, "src/a.ts");
				fs.writeFileSync(target, tsSource("a", 1, "mid-read, longer"));
				const older = new Date(Date.now() - 20_000);
				utimesSync(target, older, older);
			}
			return value;
		}) as typeof fs.readFileSync);
		spies.push(reads);
		await prepareDirtyOverlay(f.ctx());
		expect(injected).toBe(true);
		expect(f.manifest()?.hashMemo["src/a.ts"]).toBeUndefined();
	});
});

describe("candidates beyond git: W and T (HIGH 9)", () => {
	test("W-1: seen dirty, restored to HEAD while the index holds the dirty text → still served (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		const head = tsSource("a", 2);
		f.write("src/a.ts", tsSource("a", 2, "temporaryFn"));
		// An MCP search: auto-index stored the dirty revision, THEN its overlay
		// pass ran — seeing the path dirty (W) and moving the high-water mark
		// past that index row, so T cannot find it again later.
		f.index("src/a.ts");
		await prepareDirtyOverlay(f.ctx());
		expect(f.manifest()?.watch).toContain("src/a.ts");
		f.write("src/a.ts", head); // restored: git now reports it clean
		const result = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(result)).toEqual(["src/a.ts"]);
		const text = [...(result.candidates?.rowsById.values() ?? [])]
			.map((r) => r.content)
			.join("\n");
		expect(text).not.toContain("temporaryFn");
	});

	test("W-2: untracked → committed WITHOUT a reindex → still served, `dirty`, kept in W (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/n.ts", tsSource("newmod", 2));
		const first = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(first)).toEqual(["src/n.ts"]);
		expect(f.manifest()?.watch).toEqual(["src/n.ts"]);

		f.commit("add n.ts"); // git-clean now; the tracker has never seen it
		const second = await prepareDirtyOverlay(f.ctx());
		expect(second.report.reason).toBe("dirty");
		expect(servedPaths(second)).toEqual(["src/n.ts"]);
		expect(f.manifest()?.watch).toEqual(["src/n.ts"]);

		// A reindex makes it index-current: only then does it leave W. (Saved
		// a while ago: a save inside the racy window stays one more pass —
		// review 2, HIGH 1; RACE-4.)
		f.index("src/n.ts");
		f.age("src/n.ts");
		const third = await prepareDirtyOverlay(f.ctx());
		expect(third.report.reason).toBe("index-current");
		expect(third.candidates).toBeUndefined();
		expect(f.manifest()?.watch).toEqual([]);
	});

	test("CAP-1: a W of files a reindex made current never causes `too-large` (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 1),
			"src/b.ts": tsSource("b", 1),
			"src/c.ts": tsSource("c", 1),
		});
		const limits = { maxDirtyFiles: 3 };
		for (const stem of ["a", "b", "c"]) {
			f.write(`src/${stem}.ts`, tsSource(stem, 1, "edited"));
		}
		await prepareDirtyOverlay(f.ctx({ limits }));
		f.commit("edits"); // no reindex: still stale, still in W
		await prepareDirtyOverlay(f.ctx({ limits }));
		expect(f.manifest()?.watch).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

		indexAll(f, ["src/a.ts", "src/b.ts", "src/c.ts"]);
		// The edits were made a while ago (outside the racy window, which
		// keeps a just-saved file in W one more pass — review 2, HIGH 1).
		for (const stem of ["a", "b", "c"]) f.age(`src/${stem}.ts`);
		f.write("src/d.ts", tsSource("d", 1));
		const result = await prepareDirtyOverlay(f.ctx({ limits }));
		expect(result.report.state).toBe("on");
		expect(servedPaths(result)).toEqual(["src/d.ts"]);
		expect(f.manifest()?.watch).toEqual(["src/d.ts"]);
		// And G alone over the cap is still a skip.
		for (const stem of ["e", "f", "g"])
			f.write(`src/${stem}.ts`, tsSource(stem, 1));
		const over = await prepareDirtyOverlay(f.ctx({ limits }));
		expect(over.report).toMatchObject({
			state: "skipped",
			reason: "too-large",
		});
	});

	test("CAP-2: T takes in only what `watch` can keep; a stale tracker-only file is not lost (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 1),
			"src/b.ts": tsSource("b", 1),
		});
		const limits = { maxDirtyFiles: 1 };
		await prepareDirtyOverlay(f.ctx({ limits })); // records the mark
		const mark0 = f.manifest()?.trackerHighWater;
		expect(mark0).not.toBeNull();
		const headA = f.read("src/a.ts").toString("utf8");
		const headB = f.read("src/b.ts").toString("utf8");
		// b.ts: indexed while dirty, then restored → stale, git-clean, T only.
		f.write("src/b.ts", tsSource("b", 1, "indexedWhileDirty"));
		await Bun.sleep(5);
		f.index("src/b.ts");
		f.write("src/b.ts", headB);
		// a.ts: dirty and stale, filling the whole watch capacity.
		f.write("src/a.ts", tsSource("a", 1, "edited"));

		const first = await prepareDirtyOverlay(f.ctx({ limits }));
		const markAfterFirst = f.manifest()?.trackerHighWater;

		// a.ts back to HEAD (index-current, git-clean): room for b.ts — once
		// the restore is outside the racy window (review 2, HIGH 1).
		f.write("src/a.ts", headA);
		f.age("src/a.ts");
		const second = await prepareDirtyOverlay(f.ctx({ limits }));
		// THE harm first: b.ts must not have dropped out of coverage.
		expect(servedPaths(second)).toEqual(["src/b.ts"]);
		const text = [...(second.candidates?.rowsById.values() ?? [])]
			.map((r) => r.content)
			.join("\n");
		expect(text).not.toContain("indexedWhileDirty");

		// Why: the first pass took in only what `watch` could keep.
		expect(servedPaths(first)).toEqual(["src/a.ts"]);
		expect(first.report.filesUnclassified).toBeGreaterThanOrEqual(1);
		// O4: the cap is a token; "at least N" (a lower bound) is its detail.
		expect(first.report.gaps).toContain("unclassified-watch-capacity");
		const capGaps = first.report.gapDetails.filter(
			(d) => d.token === "unclassified-watch-capacity",
		);
		expect(capGaps).toHaveLength(1);
		expect(capGaps[0]?.message).toContain("at least");
		// `--agent` joins details with "; ": the cap detail must parse back as
		// ONE entry, not as two with a kind-less tail (code review 3, LOW 3b).
		// Each entry is percent-decoded, as a consumer does (outer review 2,
		// LOW 4).
		const detailsLine = overlayHeaderLines({
			...first.report,
			suppressedRows: 0,
		}).find((l) => l.startsWith("overlay_gap_details="));
		expect(
			detailsLine
				?.slice("overlay_gap_details=".length)
				.split("; ")
				.map(decodeURIComponent)
				.filter((d) => d.startsWith("unclassified-watch-capacity:")),
		).toEqual([`unclassified-watch-capacity: ${capGaps[0]?.message}`]);
		const gapsLine = overlayHeaderLines({
			...first.report,
			suppressedRows: 0,
		}).find((l) => l.startsWith("overlay_gaps="));
		// first.report.gaps ends in R3.8's tokens (it served a file); each is
		// one whole entry too.
		expect(gapsLine?.slice("overlay_gaps=".length).split("; ")).toEqual([
			...first.report.gaps,
		]);
		expect(first.report.gaps).toContain("no-code-units");
		// The mark did NOT move: b.ts's new row was still after it.
		expect(markAfterFirst).toEqual(mark0);
	});

	test("ZC-1: a committed zero-chunk file (no tracker row from the REAL rule) is index-current, not dirty forever (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("pkg/__init__.py", "");
		const untracked = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(untracked)).toEqual(["pkg/__init__.py"]);
		expect(f.manifest()?.watch).toEqual(["pkg/__init__.py"]);

		f.commit("add pkg");
		// `mnemex index`: the indexer's own rule, not the fixture's shortcut.
		expect(await f.indexAsIndexer("src/a.ts")).toBeGreaterThan(0);
		expect(await f.indexAsIndexer("pkg/__init__.py")).toBe(0);
		expect(
			f.tracker
				.getIndexedFileStates([BRANCH], ["pkg/__init__.py"])
				.get("pkg/__init__.py") ?? [],
		).toEqual([]);
		f.age("pkg/__init__.py");
		f.age("src/a.ts"); // its T row is recent; its save was not

		for (const n of [1, 2, 3]) {
			const pass = await prepareDirtyOverlay(f.ctx());
			expect(`${n}: ${pass.report.state}/${pass.report.reason}`).toBe(
				`${n}: on/index-current`,
			);
			expect(pass.report.files).toBe(0);
			expect(pass.candidates).toBeUndefined();
			expect(f.manifest()?.watch).toEqual([]);
			expect(Object.keys(f.manifest()?.files ?? {})).toEqual([]);
		}
		expect(f.stub.texts).toBe(0);
	});

	test("CAP-3: T rows already in C cost no watch capacity — the mark advances, no false 'unclassified' (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		const limits = { maxDirtyFiles: 1 };
		await prepareDirtyOverlay(f.ctx({ limits })); // the mark
		const mark0 = f.manifest()?.trackerHighWater;
		// a.ts dirty AND reindexed at that state: in G, and its new row in T.
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await Bun.sleep(5); // a later indexed_at
		f.index("src/a.ts");
		for (const n of [1, 2]) {
			const pass = await prepareDirtyOverlay(f.ctx({ limits }));
			expect(`${n}: ${pass.report.state}`).toBe(`${n}: on`);
			expect(pass.report.filesUnclassified).toBe(0);
			expect(pass.report.gaps.join("\n")).not.toContain("unclassified");
			expect(
				pass.report.gapDetails.filter((d) =>
					d.token.startsWith("unclassified"),
				),
			).toEqual([]);
			const mark = f.manifest()?.trackerHighWater;
			expect(mark).not.toEqual(mark0);
			expect(mark?.path).toBe("src/a.ts");
		}
	});

	test("HW-1: indexed after the manifest existed, then git-clean → T finds it (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		await prepareDirtyOverlay(f.ctx()); // first pass: records the high-water mark
		expect(f.manifest()?.trackerHighWater?.branchId).toBe(BRANCH);
		// `mnemex index` while b.ts was dirty, then the user restored it.
		const head = f.read("src/b.ts").toString("utf8");
		f.write("src/b.ts", tsSource("b", 2, "indexedWhileDirty"));
		await Bun.sleep(5); // a later indexed_at
		f.index("src/b.ts");
		f.write("src/b.ts", head);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(servedPaths(result)).toEqual(["src/b.ts"]);
	});

	test("SCOPE_ALL has no T and resets the mark", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		await prepareDirtyOverlay(f.ctx());
		expect(f.manifest()?.trackerHighWater).not.toBeNull();
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await prepareDirtyOverlay(
			f.ctx({ trackerBranchId: null, branchIds: [BRANCH, 2] }),
		);
		expect(f.manifest()?.trackerHighWater).toBeNull();
	});
});

describe("identity and the cache open rule", () => {
	test("MOD-1: every overlay embed goes through the query client; manifest identity is the index's; another model's manifest is wiped (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		await prepareDirtyOverlay(f.ctx());
		expect(f.manifest()?.embedding).toEqual({
			model: "stub-model",
			provider: "openrouter",
			dimension: 8,
			fingerprint: "",
		});
		const firstCalls = f.stub.texts;
		expect(firstCalls).toBeGreaterThan(0);

		// The index is now model B: the old manifest no longer matches.
		const b = new StubEmbedder("model-b");
		const result = await prepareDirtyOverlay(
			f.ctx({
				indexIdentity: { model: "model-b", provider: "openrouter" },
				queryIdentity: { model: "model-b", provider: "openrouter" },
				queryClient: b,
			}),
		);
		expect(servedPaths(result)).toEqual(["src/a.ts"]);
		expect(f.manifest()?.embedding?.model).toBe("model-b");
		expect(b.texts).toBeGreaterThan(0); // rebuilt with B, not served from A's rows
		expect(f.stub.texts).toBe(firstCalls);
	});

	test("index and query identities disagree → skipped/identity-mismatch", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		const result = await prepareDirtyOverlay(
			f.ctx({
				queryIdentity: { model: "configured-b", provider: "openrouter" },
			}),
		);
		expect(result.report.reason).toBe("identity-mismatch");
		expect(f.stub.texts).toBe(0);
	});

	test("no stored model → skipped/no-index", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		const result = await prepareDirtyOverlay(f.ctx({ indexIdentity: null }));
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "no-index",
		});
	});

	test("EC-1: index lock held in-process + cold memo → no full open, skipped (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		const opens = spyOn(embedCache, "openEmbedCache");
		spies.push(opens);
		const storeLock = createStoreLock(f.loc);
		expect((await storeLock.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		try {
			const result = await prepareDirtyOverlay(f.ctx());
			expect(result.report).toMatchObject({
				state: "skipped",
				reason: "cache-cold-under-lock",
			});
			// Only memo-only calls were made; the cache file was never created.
			expect(opens.mock.calls.length).toBeGreaterThan(0);
			for (const call of opens.mock.calls) {
				expect(call[1]).toEqual({ ifAlreadyOpen: true });
			}
			expect(existsSync(f.embedCachePath)).toBe(false);

			// With the memo WARM (as `index()` leaves it), the same pass runs.
			opens.mockRestore();
			openEmbedCache(f.embedCachePath);
			const warm = await prepareDirtyOverlay(f.ctx());
			expect(servedPaths(warm)).toEqual(["src/a.ts"]);
		} finally {
			storeLock.release();
		}
	});
});

describe("L-1 at the overlay level", () => {
	test("a pass in one worktree writes nothing in another's overlay dir", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		const linked = join(f.box.root, "linked");
		f.box.git(f.repo, "worktree", "add", "-q", "-b", "other", linked);
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await prepareDirtyOverlay(f.ctx());
		expect(existsSync(f.manifestPath)).toBe(true);
		const otherDir = getDirtyOverlayDirFor(resolveStoreLocation(linked));
		expect(otherDir).not.toBe(f.overlayDir);
		expect(existsSync(otherDir)).toBe(false);
		// And nothing under the shared store.
		const shared = f.loc.storeDir;
		if (existsSync(shared)) {
			expect(readdirSync(shared).some((n) => n.includes("overlay"))).toBe(
				false,
			);
		}
		mkdirSync(join(f.box.root, "unused"), { recursive: true });
	});
});
