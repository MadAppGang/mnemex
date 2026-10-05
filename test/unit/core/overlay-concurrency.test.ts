/**
 * Overlapping overlay passes (code review 1, HIGH 3 and MEDIUM 6).
 *
 *   RACE-1  pass A classifies from manifest S0; pass B then writes a newer M1
 *           that WATCHES a.ts and moved the mark past a.ts's row; A takes the
 *           lock. A must not write its older watch set over B's: a.ts stays in
 *           W, so once restored to HEAD (git-clean, stale against the index) it
 *           is still served. Asserted on the manifest BYTES and on the next
 *           pass's served set (HIGH 3)
 *   RACE-2  the same overlap on the bookkeeping-only path: A writes nothing,
 *           and B's built rows are not garbage-collected (HIGH 3)
 *   SF-1    two passes in ONE process at once: both serve; the second embeds
 *           nothing, because it runs after the first, not against its lock
 *           (MEDIUM 6)
 *
 * Code review 2:
 *
 *   RACE-3  RACE-1 with a.ts ALREADY in S0's watch: A must still import B's
 *           entry for it, not skip it as "already ours" (HIGH 1, variant A)
 *   RACE-4  NO second pass: a.ts is saved and reindexed between A's `git
 *           status` and A's disk read. Absent from the listing is not evidence
 *           of git-clean then: a.ts must stay in W (HIGH 1, variant B)
 *   RACY-1  that retention lasts only while the mtime is inside the racy
 *           window; an old mtime leaves W as before (no permanent watch)
 *   SF-2    N parallel passes over a CLEAN worktree overlap: the in-process
 *           gate covers only the locked section (MEDIUM 4)
 *   SF-3    a predecessor wedged INSIDE the locked section costs a follower at
 *           most the gate wait + the file-lock wait, then `busy` with the
 *           index rows visible (MEDIUM 4)
 *   SF-4    a predecessor whose `git status` never returns costs a follower
 *           nothing (MEDIUM 4)
 *   GT-1    the overlay's own `git status` carries a timeout (MEDIUM 4)
 *   SF-5    a pass whose rebuild budget the in-process wait consumed says so in
 *           its `embed-deadline` gap (LOW 11)
 *
 * The overlap is made deterministic, not raced: B's manifest is produced by a
 * REAL pass, A's snapshot is the older manifest put back on disk, and B's
 * write lands at A's first tracker read — after A's snapshot, before its lock.
 * A's git listing is the real one minus a.ts: it was taken before a.ts was
 * dirtied, which is the window this is about.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	GitDiffChangeDetector,
	type WorktreeStatusResult,
} from "../../../src/cloud/git-diff.js";
import * as overlayModule from "../../../src/core/overlay/dirty-overlay.js";
import {
	type DirtyOverlayContext,
	prepareDirtyOverlay,
} from "../../../src/core/overlay/dirty-overlay.js";
import type { OverlayReport } from "../../../src/core/overlay/types.js";
import { overlayHeaderLines } from "../../../src/output/agent.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";

/**
 * `overlay_gaps` as an `--agent` consumer parses it: split on the documented
 * "; " separator. Every entry is a closed-set token, so none contains it.
 */
function agentGapEntries(report: OverlayReport): string[] {
	const line = overlayHeaderLines({ ...report, suppressedRows: 0 }).find((l) =>
		l.startsWith("overlay_gaps="),
	);
	return line?.slice("overlay_gaps=".length).split("; ") ?? [];
}

/**
 * `overlay_gap_details` split the way an `--agent` consumer splits it: on
 * `; `, each entry percent-decoded (`;`, `%` and a path's `:` are escaped
 * inside fields, so a raw `; ` is always a separator — outer review 2, LOW 4).
 */
function agentDetailEntries(report: OverlayReport): string[] {
	const line = overlayHeaderLines({ ...report, suppressedRows: 0 }).find((l) =>
		l.startsWith("overlay_gap_details="),
	);
	const value = line?.slice("overlay_gap_details=".length) ?? "";
	return value === "" ? [] : value.split("; ").map(decodeURIComponent);
}

let fx: OverlayFixture | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	fx?.cleanup();
	fx = null;
});

/** Resolve once `cond()` holds (polled), or throw after `ms`. */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

/** The served text for `rel` in a pass's candidates. */
function servedText(
	result: Awaited<ReturnType<typeof prepareDirtyOverlay>>,
	rel: string,
): string {
	return [...(result.candidates?.rowsById.values() ?? [])]
		.filter((r) => r.filePath === rel)
		.map((r) => r.content)
		.join("\n");
}

/**
 * a.ts indexed DIRTY (as an MCP auto-index would) and b.ts edited. Returns
 * the manifest before (S0) and after (M1) a real pass over that state, with
 * S0 put back on disk as the snapshot pass A will read.
 */
async function overlapped(): Promise<{
	f: OverlayFixture;
	s0: string;
	m1: string;
	headA: string;
}> {
	const f = await createOverlayFixture({
		"src/a.ts": tsSource("a", 1),
		"src/b.ts": tsSource("b", 1),
	});
	fx = f;
	indexAll(f, ["src/a.ts", "src/b.ts"]);
	await prepareDirtyOverlay(f.ctx()); // S0: the mark, an empty watch
	const s0 = f.manifestBytes() as string;
	const headA = f.read("src/a.ts").toString("utf8");

	f.write("src/b.ts", tsSource("b", 1, "edited"));
	f.write("src/a.ts", tsSource("a", 1, "temporaryFn"));
	await Bun.sleep(5); // a later indexed_at
	f.index("src/a.ts");

	await prepareDirtyOverlay(f.ctx()); // pass B, for real
	const m1 = f.manifestBytes() as string;
	const parsed = JSON.parse(m1) as {
		watch: string[];
		trackerHighWater: { path: string };
		files: Record<string, unknown>;
	};
	expect(parsed.watch).toEqual(["src/a.ts", "src/b.ts"]);
	expect(parsed.trackerHighWater.path).toBe("src/a.ts");
	expect(Object.keys(parsed.files)).toEqual(["src/b.ts"]);

	writeFileSync(f.manifestPath, s0); // pass A will snapshot S0
	return { f, s0, m1, headA };
}

/** Pass A: an older git listing, and B's manifest landing after A's snapshot. */
function passA(
	f: OverlayFixture,
	m1: string,
	listed: (path: string) => boolean,
): DirtyOverlayContext {
	let landed = false;
	return f.ctx({
		gitStatus: async () => {
			const status = await new GitDiffChangeDetector(
				f.repo,
			).getWorktreeStatus();
			return status.ok
				? { ...status, entries: status.entries.filter((e) => listed(e.path)) }
				: status;
		},
		tracker: {
			getIndexedFileStates: (branchIds, paths) => {
				if (!landed) {
					landed = true;
					writeFileSync(f.manifestPath, m1); // B finished meanwhile
				}
				return f.tracker.getIndexedFileStates(branchIds, paths);
			},
			getFilesIndexedSince: (branchId, after, limit) =>
				f.tracker.getFilesIndexedSince(branchId, after, limit),
			getIndexedHighWater: (branchId) =>
				f.tracker.getIndexedHighWater(branchId),
		},
	});
}

describe("a pass that waited does not overwrite newer bookkeeping (HIGH 3)", () => {
	test("RACE-1: B's watch entry survives A's write; restored to HEAD, a.ts is still served (A)", async () => {
		const { f, m1, headA } = await overlapped();
		const a = await prepareDirtyOverlay(passA(f, m1, (p) => p !== "src/a.ts"));
		expect(a.report.state).toBe("on");
		expect(f.manifest()?.watch).toEqual(["src/a.ts", "src/b.ts"]);
		expect(f.manifest()?.trackerHighWater?.path).toBe("src/a.ts");

		// a.ts back to HEAD: git-clean, and the index still holds temporaryFn.
		f.write("src/a.ts", headA);
		const next = await prepareDirtyOverlay(f.ctx());
		expect(next.candidates?.servedPaths).toContain("src/a.ts");
		const text = [...(next.candidates?.rowsById.values() ?? [])]
			.filter((r) => r.filePath === "src/a.ts")
			.map((r) => r.content)
			.join("\n");
		expect(text).not.toContain("temporaryFn");
	});

	test("RACE-2: on the bookkeeping-only path A writes nothing and B's rows stay (A)", async () => {
		const { f, m1 } = await overlapped();
		const a = await prepareDirtyOverlay(passA(f, m1, () => false));
		expect(a.report.reason).toBe("index-current");
		expect(f.manifestBytes()).toBe(m1);
		const rows = await f.overlayRows();
		expect(rows.some((r) => r.filePath === "src/b.ts")).toBe(true);
	});
});

describe("two passes in one process (MEDIUM 6)", () => {
	test("SF-1: both serve; the second waits for the first and embeds nothing (A)", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 2) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		// Longer than the 2 s cross-process lock wait.
		f.stub.beforeEmbed = () => Bun.sleep(2500);
		const [one, two] = await Promise.all([
			prepareDirtyOverlay(f.ctx()),
			prepareDirtyOverlay(f.ctx()),
		]);
		expect(one.report).toMatchObject({ state: "on", reason: "dirty" });
		expect(two.report).toMatchObject({ state: "on", reason: "dirty" });
		expect(one.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(two.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(f.stub.attempts).toBe(1);
	});
});

describe("code review 2, HIGH 1: a path git did not list is not proven git-clean", () => {
	test("RACE-3: a.ts ALREADY in A's snapshot watch is still imported from B's manifest (A)", async () => {
		const f = await createOverlayFixture({
			"src/a.ts": tsSource("a", 1),
			"src/b.ts": tsSource("b", 1),
		});
		fx = f;
		indexAll(f, ["src/a.ts", "src/b.ts"]);
		await prepareDirtyOverlay(f.ctx()); // the mark
		const headA = f.read("src/a.ts").toString("utf8");
		f.write("src/a.ts", tsSource("a", 1, "early"));
		await prepareDirtyOverlay(f.ctx()); // S0: a.ts dirty, watched
		const s0 = f.manifestBytes() as string;
		expect((JSON.parse(s0) as { watch: string[] }).watch).toEqual(["src/a.ts"]);

		// RACE-1 from here: a.ts indexed dirty, b.ts edited, B runs for real.
		f.write("src/b.ts", tsSource("b", 1, "edited"));
		f.write("src/a.ts", tsSource("a", 1, "temporaryFn"));
		await Bun.sleep(5); // a later indexed_at
		f.index("src/a.ts");
		await prepareDirtyOverlay(f.ctx()); // pass B
		const m1 = f.manifestBytes() as string;
		const parsed = JSON.parse(m1) as {
			watch: string[];
			trackerHighWater: { path: string };
		};
		expect(parsed.watch).toEqual(["src/a.ts", "src/b.ts"]);
		expect(parsed.trackerHighWater.path).toBe("src/a.ts");
		writeFileSync(f.manifestPath, s0); // pass A will snapshot S0
		// Outside the racy window, so the racy rule cannot keep a.ts: only
		// reconcile's import of B's watch can (code review 3, MEDIUM 1).
		f.age("src/a.ts");

		const a = await prepareDirtyOverlay(passA(f, m1, (p) => p !== "src/a.ts"));
		expect(a.report.state).toBe("on");
		expect(f.manifest()?.watch).toContain("src/a.ts");

		// a.ts back to HEAD: git-clean, and the index still holds temporaryFn.
		f.write("src/a.ts", headA);
		const next = await prepareDirtyOverlay(f.ctx());
		expect(next.candidates?.servedPaths).toContain("src/a.ts");
		expect(next.candidates?.suppressedPaths).toContain("src/a.ts");
		expect(servedText(next, "src/a.ts")).not.toContain("temporaryFn");
		expect(servedText(next, "src/a.ts")).toContain("a_0");
	});

	test("RACE-4: NO second pass — saved and reindexed between A's git status and its disk read, a.ts stays in W (A)", async () => {
		const f = await createOverlayFixture({
			"src/a.ts": tsSource("a", 1),
			"src/b.ts": tsSource("b", 1),
		});
		fx = f;
		indexAll(f, ["src/a.ts", "src/b.ts"]);
		await prepareDirtyOverlay(f.ctx()); // the mark
		const headA = f.read("src/a.ts").toString("utf8");
		f.write("src/a.ts", tsSource("a", 1, "early"));
		await prepareDirtyOverlay(f.ctx()); // S0: a.ts watched
		expect(f.manifest()?.watch).toEqual(["src/a.ts"]);
		f.write("src/a.ts", headA); // back to HEAD, no pass yet

		// Pass A's REAL listing (a.ts clean, so not listed) is taken; THEN the
		// user saves a.ts and `mnemex watch` reindexes it; THEN A reads disk.
		const a = await prepareDirtyOverlay(
			f.ctx({
				gitStatus: async () => {
					const status = await new GitDiffChangeDetector(
						f.repo,
					).getWorktreeStatus();
					f.write("src/a.ts", tsSource("a", 1, "temporaryFn"));
					await Bun.sleep(5); // a later indexed_at
					f.index("src/a.ts");
					return status;
				},
			}),
		);
		expect(a.report.state).toBe("on");
		expect(f.manifest()?.watch).toContain("src/a.ts");

		// a.ts back to HEAD: git-clean, the index holds temporaryFn, and the
		// tracker mark is already past that row. Only W can still find it.
		f.write("src/a.ts", headA);
		const next = await prepareDirtyOverlay(f.ctx());
		expect(next.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(next.candidates?.suppressedPaths).toEqual(["src/a.ts"]);
		expect(servedText(next, "src/a.ts")).not.toContain("temporaryFn");
		expect(servedText(next, "src/a.ts")).toContain("a_0");
	});

	test("RACY-1: kept only while its mtime is inside the racy window; an old mtime leaves W (A)", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 1) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await prepareDirtyOverlay(f.ctx());
		expect(f.manifest()?.watch).toEqual(["src/a.ts"]);
		// Reindexed and committed: index-current and git-clean.
		f.index("src/a.ts");
		f.commit("edit a");
		f.age("src/a.ts"); // the save was long before this search
		const settled = await prepareDirtyOverlay(f.ctx());
		expect(settled.report.reason).toBe("index-current");
		expect(settled.candidates).toBeUndefined();
		expect(f.manifest()?.watch).toEqual([]);
	});
});

describe("code review 2, MEDIUM 4: the in-process gate covers the locked section only, bounded", () => {
	test("SF-2: five parallel passes over a CLEAN worktree overlap (A)", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 2) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		await prepareDirtyOverlay(f.ctx()); // the mark
		let inFlight = 0;
		let maxInFlight = 0;
		const slowGit = async (): Promise<WorktreeStatusResult> => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Bun.sleep(400);
			const status = await new GitDiffChangeDetector(
				f.repo,
			).getWorktreeStatus();
			inFlight--;
			return status;
		};
		const t0 = Date.now();
		const done: number[] = [];
		const results = await Promise.all(
			[0, 1, 2, 3, 4].map(async () => {
				const r = await prepareDirtyOverlay(f.ctx({ gitStatus: slowGit }));
				done.push(Date.now() - t0);
				return r;
			}),
		);
		console.log(
			`SF-2 completion ms: ${done.join(" / ")}; max concurrent git status: ${maxInFlight}`,
		);
		for (const r of results) {
			expect(r.report).toMatchObject({ state: "on", reason: "index-current" });
		}
		expect(maxInFlight).toBe(5);
		// Serialised, the fifth finished at ~5 x 400 ms (measured 2 085 ms).
		expect(Math.max(...done)).toBeLessThan(1500);
	}, 30_000);

	test("SF-3: a predecessor wedged in the locked section costs a follower ≤ gate wait + lock wait, then busy (A)", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 2) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		let release: () => void = () => {};
		const wedge = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.stub.beforeEmbed = () => wedge; // holds the overlay lock until released
		const limits = { lockWaitMs: 300 };
		const first = prepareDirtyOverlay(f.ctx({ limits }));
		try {
			await until(() => f.stub.attempts === 1);
			const t0 = Date.now();
			const second = await Promise.race([
				prepareDirtyOverlay(f.ctx({ limits })),
				Bun.sleep(5000).then(() => null),
			]);
			const waited = Date.now() - t0;
			expect(second).not.toBeNull();
			expect(second?.report).toMatchObject({
				state: "skipped",
				reason: "busy",
			});
			expect(second?.candidates).toBeUndefined(); // index rows visible
			expect(waited).toBeLessThan(2 * limits.lockWaitMs + 700);
		} finally {
			release();
			await first;
		}
	}, 30_000);

	test("SF-4: a predecessor whose git status never returns costs a follower nothing (A)", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 2) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		void prepareDirtyOverlay(f.ctx({ gitStatus: () => new Promise(() => {}) }));
		const t0 = Date.now();
		const second = await Promise.race([
			prepareDirtyOverlay(f.ctx()),
			Bun.sleep(5000).then(() => null),
		]);
		expect(second).not.toBeNull();
		expect(second?.report).toMatchObject({
			state: "on",
			reason: "index-current",
		});
		expect(Date.now() - t0).toBeLessThan(2000);
	}, 30_000);

	test("GT-1: the overlay's own git status is called with a timeout", async () => {
		const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 1) });
		fx = f;
		indexAll(f, ["src/a.ts"]);
		const seen: unknown[] = [];
		const original = GitDiffChangeDetector.prototype.getWorktreeStatus;
		const spy = spyOn(
			GitDiffChangeDetector.prototype,
			"getWorktreeStatus",
		).mockImplementation(function (this: GitDiffChangeDetector, options) {
			seen.push(options);
			return original.call(this, options);
		});
		spies.push(spy);
		const r = await prepareDirtyOverlay(f.ctx({ gitStatus: undefined }));
		expect(r.report.state).toBe("on");
		expect(seen.length).toBe(1);
		expect(seen[0]).toMatchObject({
			timeoutMs: (overlayModule as Record<string, unknown>)
				.OVERLAY_GIT_STATUS_TIMEOUT_MS,
		});
		expect(
			(overlayModule as Record<string, unknown>).OVERLAY_GIT_STATUS_TIMEOUT_MS,
		).toBeGreaterThan(0);
	});
});

describe("code review 2, LOW 11: the queue's share of a spent budget is reported", () => {
	test("SF-5: a pass that waited behind another names the wait in its embed-deadline gap", async () => {
		const f = await createOverlayFixture({
			"src/a.ts": tsSource("a", 1),
			"src/c.ts": tsSource("c", 1),
		});
		fx = f;
		indexAll(f, ["src/a.ts", "src/c.ts"]);
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		f.write("src/c.ts", tsSource("c", 1, "edited"));
		let calls = 0;
		const original = f.stub.embed.bind(f.stub);
		f.stub.embed = async (texts, onProgress, options) => {
			calls++;
			if (calls === 1) {
				await Bun.sleep(600); // the first pass holds the gate meanwhile
				return original(texts, onProgress, options);
			}
			f.stub.policies.push(options);
			// Every later call stalls until the overlay's deadline aborts it.
			await new Promise<never>((_resolve, reject) => {
				const signal = options?.signal;
				if (signal === undefined) return;
				if (signal.aborted) reject(signal.reason);
				else
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
			});
			throw new Error("unreachable");
		};
		// The first pass's listing predates c.ts's edit: it builds a.ts only.
		const first = prepareDirtyOverlay(
			f.ctx({
				gitStatus: async () => {
					const status = await new GitDiffChangeDetector(
						f.repo,
					).getWorktreeStatus();
					return status.ok
						? {
								...status,
								entries: status.entries.filter((e) => e.path !== "src/c.ts"),
							}
						: status;
				},
			}),
		);
		await until(() => calls === 1);
		const second = await prepareDirtyOverlay(
			f.ctx({ limits: { rebuildBudgetMs: 300 } }),
		);
		await first;
		expect(second.report.gaps).toContain("embed-deadline");
		const gap = second.report.gapDetails.find(
			(d) => d.token === "embed-deadline",
		);
		expect(gap).toBeDefined();
		expect(gap?.message).toMatch(
			/\d+ ms were spent queued behind another search/,
		);
		// The queued variant, as an `--agent` consumer splits it: one entry.
		expect(agentGapEntries(second.report)).toEqual([...second.report.gaps]);
		expect(agentDetailEntries(second.report)).toContain(
			`embed-deadline: ${gap?.message}`,
		);
		expect(second.candidates?.servedPaths).toEqual(["src/a.ts"]);
	}, 30_000);
});

describe("outer review 2, MEDIUM: reconciliation at the watch capacity", () => {
	/**
	 * RACE-5. A's own capacity checks ran BEFORE the lock, against S0. Under
	 * the lock it imports B's watch (a.ts, b.ts), so W' is {b (G), a
	 * (imported)} — two paths against a cap of one — while the mark becomes
	 * B's, past a.ts's tracker row. Shipped: `nextWatch` kept the G member
	 * and sliced a.ts away, and the manifest recorded `watch: ["src/a.ts"]`
	 * gone with the mark past it: once restored to HEAD, a.ts's stale index
	 * rows came back with no overlay warning, on every later pass.
	 *
	 * The invariant: a path never SILENTLY leaves the watch set while its
	 * stale index rows would return. A pass that cannot keep the union skips
	 * as `too-large` and leaves B's manifest exactly as B wrote it.
	 */
	test("RACE-5: an import that overflows the cap skips too-large and leaves B's manifest bytes; a.ts is still served once restored (A)", async () => {
		const { f, m1, headA } = await overlapped();
		// Outside the racy window, so only reconcile's import can keep a.ts.
		f.age("src/a.ts");
		const ctxA = passA(f, m1, (p) => p !== "src/a.ts");
		const a = await prepareDirtyOverlay({
			...ctxA,
			limits: { ...ctxA.limits, maxDirtyFiles: 1 },
		});
		expect(a.report).toMatchObject({ state: "skipped", reason: "too-large" });
		expect(a.candidates).toBeUndefined();
		// The bytes on disk: B's manifest, untouched — a.ts still watched, and
		// the mark B advanced is still B's.
		expect(f.manifestBytes()).toBe(m1);
		expect(f.manifest()?.watch).toContain("src/a.ts");

		// a.ts back to HEAD: git-clean, and the index still holds temporaryFn.
		f.write("src/a.ts", headA);
		const next = await prepareDirtyOverlay(f.ctx());
		expect(next.candidates?.servedPaths).toContain("src/a.ts");
		expect(next.candidates?.suppressedPaths).toContain("src/a.ts");
		expect(servedText(next, "src/a.ts")).not.toContain("temporaryFn");
	});
});
