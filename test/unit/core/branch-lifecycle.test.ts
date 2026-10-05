/**
 * The branch-confirmation pass, Phase A and Phase B (architecture §4.3, §3.4),
 * and V3.9's lifecycle shapes.
 *
 * ── WHY THE DECISION ARITHMETIC IS DRIVEN DIRECTLY ─────────────────────────
 * `EPHEMERAL_MAX` is 32, `EPHEMERAL_TTL_MS` is 7 days and
 * `BRANCH_DELETE_GRACE_MS` is 24 h. Reaching those through real index runs
 * would cost 33 checkouts and two injected clocks per assertion, and would test
 * the indexer rather than the rule. `decideBranchLifecycle` is a pure function
 * of (registry snapshot, ref set, now), so the rules are exercised here and the
 * END-TO-END path — a real repository, real `mnemex index` runs, an injected
 * clock, packed refs — is `branch-termination.test.ts` (V3.8).
 *
 * The ref READING half is not simulated: it runs against real `refs/heads/**`
 * trees and real `packed-refs` files, because the whole of G2 is that reading
 * one source and not the other is the defect.
 *
 * Phase B is driven through a REAL registry under a REAL store lock
 * (`createStoreLock` + `acquire`), because REG-1's check reads the lock's
 * ownership token and a stub would test the stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRANCH_CONFIRM_INTERVAL,
	BRANCH_DELETE_GRACE_MS,
	BRANCH_SOFT_LIMIT,
	confirmScan,
	decideBranchLifecycle,
	EPHEMERAL_MAX,
	EPHEMERAL_TTL_MS,
	isLiveEntry,
	shouldConfirmBranches,
} from "../../../src/core/branch-lifecycle.js";
import {
	type BranchEntry,
	openRegistry,
} from "../../../src/core/branch-registry.js";
import { __setClockForTests } from "../../../src/core/clock.js";
import {
	type GitHead,
	type GitLayout,
	readCurrentHead,
	readGitLayout,
} from "../../../src/core/git-layout.js";
import { createStoreLock, type IndexLock } from "../../../src/core/lock.js";
import {
	__resetStoreLocationCacheForTests,
	resolveStoreLocation,
	type StoreLocation,
} from "../../../src/core/store-location.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";

const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 3_600_000;

function entry(
	id: number,
	label: string,
	over: Partial<BranchEntry> = {},
): BranchEntry {
	return {
		id,
		label,
		kind: "branch",
		ephemeral: false,
		headSha: null,
		firstSeen: new Date(T0).toISOString(),
		lastSeen: new Date(T0).toISOString(),
		lastIndexedAt: null,
		deletedAt: null,
		unconfirmedSince: null,
		needsReindex: false,
		...over,
	};
}

function ephemeral(id: number, label: string, seenAt: number): BranchEntry {
	return entry(id, label, {
		kind: "detached",
		ephemeral: true,
		lastSeen: new Date(seenAt).toISOString(),
	});
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE A — reading the two ref sources
// ════════════════════════════════════════════════════════════════════════════

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-lifecycle-"));
});
afterEach(() => {
	__setClockForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

/** A `.git`-shaped directory we can fill with refs by hand. */
function makeLayout(name: string): GitLayout {
	const worktree = join(dir, name);
	const gitDir = join(worktree, ".git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	return {
		worktreeRoot: worktree,
		gitDir,
		gitCommonDir: gitDir,
		isLinkedWorktree: false,
		isBare: false,
	};
}

function writeLooseRef(layout: GitLayout, ref: string): void {
	const path = join(layout.gitCommonDir, "refs", "heads", ...ref.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${"a".repeat(40)}\n`);
}

describe("Phase A reads BOTH ref sources (G2)", () => {
	test("a branch that exists ONLY in packed-refs is not reported missing", async () => {
		const layout = makeLayout("packed");
		writeFileSync(
			join(layout.gitCommonDir, "packed-refs"),
			"# pack-refs with: peeled fully-peeled sorted \n" +
				`${"b".repeat(40)} refs/heads/main\n` +
				`${"c".repeat(40)} refs/tags/v1.0.0\n` +
				`^${"d".repeat(40)}\n` +
				`${"e".repeat(40)} refs/heads/feature/nested\n` +
				`${"f".repeat(40)} refs/remotes/origin/main\n`,
		);

		const scan = await confirmScan(
			layout,
			[entry(1, "main"), entry(2, "feature/nested"), entry(3, "gone")],
			{ nowMs: T0 },
		);

		// This is the whole of G2: with loose refs only, all three of these would
		// be "missing" and every one of them would end up tombstoned.
		expect(scan.missingRefs).toEqual(["gone"]);
		expect(scan.deferred).toBe(false);
		// A tag and a remote-tracking ref are not branch labels in this registry's
		// sense, so they do not count as refs. Asserted through `refsRead` so a
		// change that started counting them is visible.
		expect(scan.refsRead).toBe(2);
	});

	test("loose refs are read too, including nested ones", async () => {
		const layout = makeLayout("loose");
		writeLooseRef(layout, "main");
		writeLooseRef(layout, "feature/deep/branch");

		const scan = await confirmScan(
			layout,
			[
				entry(1, "main"),
				entry(2, "feature/deep/branch"),
				entry(3, "not-a-branch"),
			],
			{ nowMs: T0 },
		);
		expect(scan.missingRefs).toEqual(["not-a-branch"]);
	});

	test("a fully packed repository with NO refs/heads directory still reads", async () => {
		const layout = makeLayout("no-loose");
		rmSync(join(layout.gitCommonDir, "refs", "heads"), {
			recursive: true,
			force: true,
		});
		writeFileSync(
			join(layout.gitCommonDir, "packed-refs"),
			`${"b".repeat(40)} refs/heads/main\n`,
		);
		const scan = await confirmScan(layout, [entry(1, "main")], { nowMs: T0 });
		expect(scan.deferred).toBe(false);
		expect(scan.missingRefs).toEqual([]);
	});

	test("an oversized packed-refs DEFERS, and decides nothing at all", async () => {
		const layout = makeLayout("huge");
		writeFileSync(
			join(layout.gitCommonDir, "packed-refs"),
			`${"b".repeat(40)} refs/heads/main\n`.repeat(200),
		);
		const scan = await confirmScan(layout, [entry(1, "gone")], {
			nowMs: T0,
			packedRefsMaxBytes: 64,
		});
		// A PARTIAL ref set makes live branches look deleted, and the decision
		// that follows from that is a tombstone. So: nothing.
		expect(scan.deferred).toBe(true);
		expect(scan.decisions).toEqual([]);
		expect(scan.missingRefs).toEqual([]);
		expect(scan.deferredReason).toContain("packed-refs");
	});

	test("too many loose refs DEFERS for the same reason", async () => {
		const layout = makeLayout("many");
		for (let i = 0; i < 12; i++) writeLooseRef(layout, `b${i}`);
		const scan = await confirmScan(layout, [entry(1, "gone")], {
			nowMs: T0,
			looseRefsMax: 4,
		});
		expect(scan.deferred).toBe(true);
		expect(scan.decisions).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The decision arithmetic
// ════════════════════════════════════════════════════════════════════════════

describe("the grace: two passes AND elapsed time (N29)", () => {
	const refs = new Set<string>(["main"]);

	test("the first miss only marks unconfirmed", () => {
		const { decisions } = decideBranchLifecycle(
			[entry(1, "main"), entry(2, "gone")],
			refs,
			{ nowMs: T0 },
		);
		expect(decisions).toEqual([
			{
				id: 2,
				label: "gone",
				set: "unconfirmedSince",
				observedLastSeen: new Date(T0).toISOString(),
				reason: "ref-absent",
			},
		]);
	});

	test("a second miss INSIDE the grace decides nothing", () => {
		const { decisions } = decideBranchLifecycle(
			[
				entry(2, "gone", {
					unconfirmedSince: new Date(T0).toISOString(),
				}),
			],
			refs,
			{ nowMs: T0 + BRANCH_DELETE_GRACE_MS - HOUR },
		);
		expect(decisions).toEqual([]);
	});

	test("a miss PAST the grace tombstones", () => {
		const { decisions } = decideBranchLifecycle(
			[entry(2, "gone", { unconfirmedSince: new Date(T0).toISOString() })],
			refs,
			{ nowMs: T0 + BRANCH_DELETE_GRACE_MS + 1 },
		);
		expect(decisions.map((d) => [d.id, d.set, d.reason])).toEqual([
			[2, "deletedAt", "grace-expired"],
		]);
	});

	test("a branch whose ref came BACK is never tombstoned", () => {
		const { decisions, missingRefs } = decideBranchLifecycle(
			[
				entry(2, "gone", {
					unconfirmedSince: new Date(
						T0 - 10 * BRANCH_DELETE_GRACE_MS,
					).toISOString(),
				}),
			],
			new Set(["gone"]),
			{ nowMs: T0 },
		);
		expect(decisions).toEqual([]);
		expect(missingRefs).toEqual([]);
	});

	test("an EPHEMERAL entry is never judged by its ref: a sha is not a branch name", () => {
		// A detached HEAD's label is a 40-hex sha, which never appears as a ref
		// NAME. Judging it by ref presence would tombstone every detached
		// checkout on its first pass.
		const { decisions, missingRefs } = decideBranchLifecycle(
			[ephemeral(3, "f".repeat(40), T0)],
			new Set(["main"]),
			{ nowMs: T0 },
		);
		expect(decisions).toEqual([]);
		expect(missingRefs).toEqual([]);
	});
});

describe("V3.9 — ephemeral entries are bounded", () => {
	test("an ephemeral entry older than the TTL is tombstoned", () => {
		const { decisions } = decideBranchLifecycle(
			[ephemeral(3, "a".repeat(40), T0 - EPHEMERAL_TTL_MS - 1)],
			new Set(),
			{ nowMs: T0 },
		);
		expect(decisions.map((d) => d.reason)).toEqual(["ephemeral-ttl"]);
	});

	test("33 detached checkouts leave at most EPHEMERAL_MAX live ephemerals", () => {
		// The shape §4.3 names: CI checkouts, bisect steps and tag checkouts
		// allocating a durable id per commit with nothing reclaiming them.
		const entries = Array.from({ length: 33 }, (_, i) =>
			ephemeral(i + 1, `${i}`.padStart(40, "0"), T0 - (33 - i) * 1000),
		);
		const { decisions } = decideBranchLifecycle(entries, new Set(), {
			nowMs: T0,
		});
		const evicted = new Set(decisions.map((d) => d.id));
		expect(decisions.every((d) => d.reason === "ephemeral-max")).toBe(true);
		expect(33 - evicted.size).toBe(EPHEMERAL_MAX);
		// Oldest `lastSeen` first: id 1 was seen 33 s ago, id 33 one second ago.
		expect([...evicted]).toEqual([1]);
	});

	test("the TTL's victims are not counted twice by the cap", () => {
		const entries = [
			ephemeral(1, "a".repeat(40), T0 - EPHEMERAL_TTL_MS - 1),
			...Array.from({ length: EPHEMERAL_MAX }, (_, i) =>
				ephemeral(i + 2, `${i}`.padStart(40, "0"), T0 - i * 1000),
			),
		];
		const { decisions } = decideBranchLifecycle(entries, new Set(), {
			nowMs: T0,
		});
		// Without the exclusion the cap would see 33 survivors and evict one more.
		expect(decisions.map((d) => d.reason)).toEqual(["ephemeral-ttl"]);
	});

	test("a NON-ephemeral branch is never evicted by the cap", () => {
		const entries = [
			...Array.from({ length: EPHEMERAL_MAX + 5 }, (_, i) =>
				entry(i + 1, `branch-${i}`),
			),
		];
		const { decisions } = decideBranchLifecycle(
			entries,
			new Set(entries.map((e) => e.label)),
			{ nowMs: T0 },
		);
		expect(decisions).toEqual([]);
	});
});

describe("when the pass runs at all", () => {
	test("every BRANCH_CONFIRM_INTERVAL runs", () => {
		expect(shouldConfirmBranches(BRANCH_CONFIRM_INTERVAL, 1, 0)).toBe(true);
		expect(shouldConfirmBranches(BRANCH_CONFIRM_INTERVAL - 1, 1, 0)).toBe(
			false,
		);
		expect(shouldConfirmBranches(2 * BRANCH_CONFIRM_INTERVAL, 1, 0)).toBe(true);
	});

	test("or whenever the registry is over a size trigger", () => {
		expect(shouldConfirmBranches(3, BRANCH_SOFT_LIMIT + 1, 0)).toBe(true);
		// The SECOND size trigger, which the design does not name: without it
		// 33 detached checkouts sit 19 runs above EPHEMERAL_MAX waiting for the
		// interval, and V3.9's "33 checkouts leave <= EPHEMERAL_MAX" is false for
		// most of that window.
		expect(shouldConfirmBranches(3, 5, EPHEMERAL_MAX + 1)).toBe(true);
		expect(shouldConfirmBranches(3, 5, EPHEMERAL_MAX)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE B — under a real lock, against a real registry
// ════════════════════════════════════════════════════════════════════════════

describe("Phase B validates every decision against the LOCK-HELD entry", () => {
	let loc: StoreLocation;
	let lock: IndexLock;

	beforeEach(async () => {
		__resetStoreLocationCacheForTests();
		mkdirSync(join(dir, "proj"), { recursive: true });
		loc = resolveStoreLocation(join(dir, "proj"));
		mkdirSync(loc.storeDir, { recursive: true });
		lock = createStoreLock(loc);
		await lock.acquire({ waitTimeout: 0 });
		__setClockForTests(() => T0);
	});
	afterEach(() => {
		lock.release();
		__resetStoreLocationCacheForTests();
	});

	const noRows = { highestBranchId: (): number | null => null };
	const branch = (label: string): GitHead => ({
		label,
		kind: "branch",
		ref: `refs/heads/${label}`,
	});

	/**
	 * Entries that exist WITHOUT this run having resolved them.
	 *
	 * Written by a first registry handle and read back by a second, because
	 * `pinned` is per-HANDLE: an entry `resolveId` touched is pinned for that
	 * handle's whole life (D7), so a test that resolved its own target would be
	 * testing the pin and nothing else.
	 */
	function seed(
		labels: string[],
	): Map<string, { id: number; lastSeen: string }> {
		const first = openRegistry(loc, lock, noRows);
		for (const label of labels) first.resolveId(branch(label));
		first.flush();
		const out = new Map<string, { id: number; lastSeen: string }>();
		for (const e of first.entries()) {
			out.set(e.label, { id: e.id, lastSeen: e.lastSeen });
		}
		return out;
	}

	test("D7: the entry THIS run resolved is never tombstoned", () => {
		const seeded = seed(["parked"]);
		const registry = openRegistry(loc, lock, noRows);
		// The parked worktree's own run: it resolves its label, so the confirm
		// pass in the SAME run may not evict it however old `lastSeen` is.
		const id = registry.resolveId(branch("parked"));
		const applied = registry.applyBranchDecisions([
			{
				id,
				label: "parked",
				set: "deletedAt",
				observedLastSeen: seeded.get("parked")?.lastSeen ?? "",
				reason: "ephemeral-max",
			},
		]);
		expect(applied.applied).toEqual([]);
		expect(applied.dropped[0].why).toContain("pinnedThisRun");
		expect(registry.entries()[0].deletedAt).toBeNull();
	});

	test("a decision whose entry moved since the scan is DROPPED", () => {
		const seeded = seed(["a", "b"]);
		const registry = openRegistry(loc, lock, noRows);
		registry.resolveId(branch("a"));
		const applied = registry.applyBranchDecisions([
			{
				id: seeded.get("b")?.id ?? -1,
				label: "b",
				set: "unconfirmedSince",
				observedLastSeen: "1999-01-01T00:00:00.000Z",
				reason: "ref-absent",
			},
		]);
		expect(applied.applied).toEqual([]);
		expect(applied.dropped[0].why).toContain("lastSeen");
	});

	test("an `unconfirmedSince` that is ALREADY set is not re-stamped", () => {
		const seeded = seed(["pinned", "gone"]);
		const registry = openRegistry(loc, lock, noRows);
		registry.resolveId(branch("pinned"));
		const decision = {
			id: seeded.get("gone")?.id ?? -1,
			label: "gone",
			set: "unconfirmedSince" as const,
			observedLastSeen: seeded.get("gone")?.lastSeen ?? "",
			reason: "ref-absent" as const,
		};
		expect(registry.applyBranchDecisions([decision]).applied).toHaveLength(1);
		// Re-stamping would push the grace out by a whole period every time two
		// processes scanned at once — the tombstone would recede for ever.
		const second = registry.applyBranchDecisions([decision]);
		expect(second.applied).toEqual([]);
		expect(second.dropped[0].why).toContain("already set");
	});

	test("a grace-expired decision is dropped when the entry was resurrected", () => {
		const seeded = seed(["pinned", "back"]);
		const registry = openRegistry(loc, lock, noRows);
		registry.resolveId(branch("pinned"));
		const applied = registry.applyBranchDecisions([
			{
				id: seeded.get("back")?.id ?? -1,
				label: "back",
				set: "deletedAt",
				observedLastSeen: seeded.get("back")?.lastSeen ?? "",
				reason: "grace-expired",
			},
		]);
		// `unconfirmedSince` is null, so no grace has run and nothing can have
		// expired.
		expect(applied.applied).toEqual([]);
		expect(applied.dropped[0].why).toContain("unconfirmedSince was cleared");
	});

	test("a valid decision IS applied, and reaches the file", () => {
		const seeded = seed(["pinned", "gone"]);
		const registry = openRegistry(loc, lock, noRows);
		registry.resolveId(branch("pinned"));
		const id = seeded.get("gone")?.id ?? -1;
		registry.applyBranchDecisions([
			{
				id,
				label: "gone",
				set: "unconfirmedSince",
				observedLastSeen: seeded.get("gone")?.lastSeen ?? "",
				reason: "ref-absent",
			},
		]);
		registry.flush();
		const entries = openRegistry(loc, lock, noRows).entries();
		expect(entries.find((e) => e.id === id)?.unconfirmedSince).toBe(
			new Date(T0).toISOString(),
		);
		// Still LIVE: `unconfirmedSince` is the first of two steps, not a
		// tombstone.
		expect(entries.filter(isLiveEntry)).toHaveLength(2);
	});

	test("rule R resurrects, and the sweep then has nothing to target", () => {
		const seeded = seed(["gone"]);
		const first = openRegistry(loc, lock, noRows);
		first.applyBranchDecisions([
			{
				id: seeded.get("gone")?.id ?? -1,
				label: "gone",
				set: "unconfirmedSince",
				observedLastSeen: seeded.get("gone")?.lastSeen ?? "",
				reason: "ref-absent",
			},
		]);
		first.flush();

		// The branch is checked out again. §4.3: "the sweep skips any id that
		// `resolveId` resurrected in this run" — expressed as a CONSEQUENCE of
		// rule R clearing `deletedAt`, not as a second rule that can be forgotten.
		const second = openRegistry(loc, lock, noRows);
		const id = second.resolveId(branch("gone"));
		expect(id).toBe(seeded.get("gone")?.id);
		expect(second.resolved).toEqual({ id, resurrected: true });
		expect(second.entries().filter((e) => e.deletedAt !== null)).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// V3.9 — the shapes, against REAL git
// ════════════════════════════════════════════════════════════════════════════

describe("V3.9 — a detached HEAD and a tag checkout are the same shape", () => {
	test("both give kind 'detached' and ephemeral: true", () => {
		const sandbox = createGitSandbox("mnemex-shapes-");
		try {
			const repo = join(sandbox.root, "repo");
			sandbox.git(sandbox.root, "init", "repo");
			writeFileSync(join(repo, "a.txt"), "one\n");
			sandbox.git(repo, "add", "-A");
			sandbox.git(repo, "commit", "-m", "one");
			sandbox.git(repo, "tag", "v1.0.0");
			const sha = sandbox.git(repo, "rev-parse", "HEAD");

			const onBranch = headOf(repo);
			expect(onBranch.kind).toBe("branch");
			expect(onBranch.label).toBe("main");

			sandbox.git(repo, "checkout", "--detach", sha);
			const detached = headOf(repo);
			expect(detached.kind).toBe("detached");
			expect(detached.label).toBe(sha);

			// A TAG checkout is a detached HEAD — it is not its own kind, and the
			// registry must not treat it as one. Same sha, same label, same entry.
			sandbox.git(repo, "checkout", "v1.0.0");
			const tagged = headOf(repo);
			expect(tagged.kind).toBe("detached");
			expect(tagged.label).toBe(sha);

			// `ephemeral` is derived as `kind !== "branch"`, so both are ephemeral
			// and both are subject to the TTL and the cap.
			expect(detached.kind !== "branch").toBe(true);
			expect(tagged.kind !== "branch").toBe(true);
		} finally {
			sandbox.cleanup();
		}
	});
});

function headOf(repo: string): GitHead {
	const result = readGitLayout(repo);
	if (result.layout === null) throw new Error("no git layout");
	return readCurrentHead(result.layout);
}
