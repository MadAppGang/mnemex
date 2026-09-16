/**
 * The branch registry (architecture §3.4): W-R1's durable allocation, the final
 * on-disk format, `openRegistry`'s `nextId` raise, and REG-1's runtime check.
 *
 * Every property is asserted on the BYTES of `branches.json`, parsed here with
 * an independent `JSON.parse`, never through the registry's own view of itself.
 * A report object cannot show a lost update or an allocation that never reached
 * the disk, and those are exactly the two failures this file exists to catch.
 *
 * The lock is the real store lock (`createStoreLock` + `acquire`) in a temp
 * directory: REG-1's check reads its ownership token, so a stub would test the
 * stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BranchEntry,
	BranchRegistryCorruptError,
	openRegistry,
	RegistryNotLockedError,
} from "../../../src/core/branch-registry.js";
import { __setClockForTests } from "../../../src/core/clock.js";
import type { GitHead } from "../../../src/core/git-layout.js";
import { createStoreLock, type IndexLock } from "../../../src/core/lock.js";
import {
	__resetStoreLocationCacheForTests,
	getBranchRegistryPathFor,
	resolveStoreLocation,
	type StoreLocation,
} from "../../../src/core/store-location.js";

const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const ENTRY_FIELDS = [
	"id",
	"label",
	"kind",
	"ephemeral",
	"headSha",
	"firstSeen",
	"lastSeen",
	"lastIndexedAt",
	"deletedAt",
	"unconfirmedSince",
	"needsReindex",
];

const branch = (label: string): GitHead => ({
	label,
	kind: "branch",
	ref: `refs/heads/${label}`,
});
const noRows = { highestBranchId: (): number | null => null };

let dir: string;
let loc: StoreLocation;
let lock: IndexLock;
let clock = T0;

async function takeLock(target: IndexLock): Promise<void> {
	const result = await target.acquire({ waitTimeout: 0 });
	if (!result.acquired) throw new Error("fixture: could not take the lock");
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "branch-registry-"));
	__resetStoreLocationCacheForTests();
	loc = resolveStoreLocation(dir);
	lock = createStoreLock(loc);
	await takeLock(lock);
	clock = T0;
	__setClockForTests(() => clock);
});

afterEach(() => {
	lock.release();
	__setClockForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

function registryPath(): string {
	return getBranchRegistryPathFor(loc);
}

/** branches.json as bytes -> an independent parse. */
function onDisk(): {
	formatVersion: number;
	nextId: number;
	branches: BranchEntry[];
} {
	return JSON.parse(readFileSync(registryPath(), "utf8"));
}

function entry(
	id: number,
	label: string,
	extra: Partial<BranchEntry> = {},
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
		...extra,
	};
}

function writeRegistry(value: unknown): string {
	mkdirSync(loc.storeDir, { recursive: true });
	const text =
		typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(registryPath(), text);
	return text;
}

describe("W-R1: an allocation is on disk before any row can carry it", () => {
	test("a new label's entry and nextId are in branches.json when resolveId returns, with no flush()", () => {
		const registry = openRegistry(loc, lock, noRows);
		expect(existsSync(registryPath())).toBe(false);

		const id = registry.resolveId(branch("main"));

		expect(id).toBe(1);
		const file = onDisk();
		expect(file.nextId).toBe(2);
		expect(file.branches.map((b) => [b.id, b.label])).toEqual([[1, "main"]]);
	});

	test("ids are never reused: a second label is 2, and nextId moves to 3", () => {
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("main"))).toBe(1);
		expect(registry.resolveId(branch("feature/x"))).toBe(2);
		const file = onDisk();
		expect(file.nextId).toBe(3);
		expect(file.branches.map((b) => b.id)).toEqual([1, 2]);
	});

	test("a known label keeps its id, and its lastSeen refresh waits for flush()", async () => {
		openRegistry(loc, lock, noRows).resolveId(branch("main"));
		lock.release();
		await takeLock(lock);

		clock = T0 + 60_000;
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("main"))).toBe(1);
		// Not an allocation, so no early rename.
		expect(onDisk().branches[0].lastSeen).toBe(new Date(T0).toISOString());

		registry.flush();
		const after = onDisk();
		expect(after.branches[0].lastSeen).toBe(
			new Date(T0 + 60_000).toISOString(),
		);
		expect(after.branches[0].firstSeen).toBe(new Date(T0).toISOString());
		expect(after.nextId).toBe(2);
	});
});

describe("the on-disk format is the final one (formatVersion 1)", () => {
	test("every entry carries every field the design gives it, tombstones included, in order", () => {
		openRegistry(loc, lock, noRows).resolveId(branch("main"));
		const file = onDisk();
		expect(Object.keys(file)).toEqual(["formatVersion", "nextId", "branches"]);
		expect(file.formatVersion).toBe(1);
		expect(Object.keys(file.branches[0])).toEqual(ENTRY_FIELDS);
		expect(file.branches[0]).toEqual(entry(1, "main"));
	});

	test("detached and unknown HEADs are ephemeral; a branch is not", () => {
		const registry = openRegistry(loc, lock, noRows);
		const sha = "f6ca985c0000000000000000000000000000abcd";
		registry.resolveId({ label: sha, kind: "detached", ref: null });
		registry.resolveId({
			label: "HEAD@0123456789ab",
			kind: "unknown",
			ref: null,
		});
		registry.resolveId(branch("main"));
		expect(onDisk().branches.map((b) => [b.kind, b.ephemeral])).toEqual([
			["detached", true],
			["unknown", true],
			["branch", false],
		]);
	});
});

describe("openRegistry raises nextId above every id a row carries (C1, mechanism 2)", () => {
	test("rows carrying 7 under a registry that says nextId 2: the next label is 8, not 2", () => {
		writeRegistry({
			formatVersion: 1,
			nextId: 2,
			branches: [entry(1, "main")],
		});
		const registry = openRegistry(loc, lock, { highestBranchId: () => 7 });
		expect(registry.resolveId(branch("feature")).valueOf()).toBe(8);
		expect(onDisk().nextId).toBe(9);
	});

	test("the raise covers an entry above nextId too (a hand-edited file)", () => {
		writeRegistry({
			formatVersion: 1,
			nextId: 3,
			branches: [entry(5, "main")],
		});
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("feature"))).toBe(6);
	});

	test("no row carries an id: nextId stands", () => {
		writeRegistry({
			formatVersion: 1,
			nextId: 4,
			branches: [entry(1, "main")],
		});
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("feature"))).toBe(4);
	});
});

describe("REG-1: branches.json is written only under the store lock it was opened under", () => {
	test("opening without the lock held is refused, and writes nothing", () => {
		lock.release();
		expect(() => openRegistry(loc, lock, noRows)).toThrow(
			RegistryNotLockedError,
		);
		expect(existsSync(registryPath())).toBe(false);
	});

	test("a held lock on ANOTHER store is refused", async () => {
		const otherDir = mkdtempSync(join(tmpdir(), "branch-registry-other-"));
		const other = createStoreLock(resolveStoreLocation(otherDir));
		await takeLock(other);
		try {
			expect(() => openRegistry(loc, other, noRows)).toThrow(
				RegistryNotLockedError,
			);
		} finally {
			other.release();
			rmSync(otherDir, { recursive: true, force: true });
		}
		expect(existsSync(registryPath())).toBe(false);
	});

	test("a mutation after the lock is released is refused, and writes nothing", () => {
		const registry = openRegistry(loc, lock, noRows);
		lock.release();
		expect(() => registry.resolveId(branch("main"))).toThrow(
			RegistryNotLockedError,
		);
		expect(() => registry.flush()).toThrow(RegistryNotLockedError);
		expect(existsSync(registryPath())).toBe(false);
	});

	test("a handle from one acquisition is refused under the next", async () => {
		const registry = openRegistry(loc, lock, noRows);
		lock.release();
		await takeLock(lock);
		expect(() => registry.resolveId(branch("main"))).toThrow(
			RegistryNotLockedError,
		);
		expect(existsSync(registryPath())).toBe(false);
	});
});

describe("a registry that cannot be trusted is REFUSED, never reset", () => {
	const cases: Array<[string, unknown]> = [
		["not JSON", "{ nope"],
		["an unknown formatVersion", { formatVersion: 2, nextId: 2, branches: [] }],
		[
			"a duplicated id",
			{ formatVersion: 1, nextId: 3, branches: [entry(1, "a"), entry(1, "b")] },
		],
		[
			"a duplicated live label",
			{ formatVersion: 1, nextId: 3, branches: [entry(1, "a"), entry(2, "a")] },
		],
		[
			"an entry missing a tombstone field",
			{
				formatVersion: 1,
				nextId: 2,
				branches: [{ ...entry(1, "a"), deletedAt: undefined }],
			},
		],
		["a nextId of 0", { formatVersion: 1, nextId: 0, branches: [] }],
	];
	for (const [what, value] of cases) {
		test(`${what}: refused, and the file is left byte-for-byte as it was`, () => {
			const before = writeRegistry(value);
			expect(() => openRegistry(loc, lock, noRows)).toThrow(
				BranchRegistryCorruptError,
			);
			expect(readFileSync(registryPath(), "utf8")).toBe(before);
		});
	}
});

describe("rule R (§3.4): a tombstoned or unconfirmed label is RESURRECTED, keeping its id", () => {
	for (const field of ["deletedAt", "unconfirmedSince"] as const) {
		test(`${field} set: the same id comes back, both fields cleared`, () => {
			writeRegistry({
				formatVersion: 1,
				nextId: 2,
				branches: [
					entry(1, "main", {
						deletedAt: new Date(T0 - 1000).toISOString(),
						unconfirmedSince: new Date(T0 - 2000).toISOString(),
						[field]: new Date(T0).toISOString(),
					}),
				],
			});
			const registry = openRegistry(loc, lock, noRows);

			// Allocating a FRESH id here would strand every row the sweep had not
			// reached under an id nothing resolves to — unrecoverable by any pass
			// in this design.
			expect(registry.resolveId(branch("main"))).toBe(1);
			expect(registry.resolved).toEqual({ id: 1, resurrected: true });

			// Durable AT ONCE, before the flush: a crash here must not leave the
			// entry tombstoned while this run's rows carry its id.
			const entryOnDisk = onDisk().branches[0];
			expect(entryOnDisk.deletedAt).toBeNull();
			expect(entryOnDisk.unconfirmedSince).toBeNull();
			expect(entryOnDisk.lastSeen).toBe(new Date(T0).toISOString());
			expect(onDisk().nextId).toBe(2);
		});
	}

	test("an ORDINARY live label reports resurrected: false", () => {
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("main"))).toBe(1);
		expect(registry.resolved).toEqual({ id: 1, resurrected: false });
		expect(registry.resolveId(branch("main"))).toBe(1);
		expect(registry.resolved).toEqual({ id: 1, resurrected: false });
	});

	test("resurrection reuses the HIGHEST id when a label somehow has two entries", () => {
		// Not reachable through this build's own writes — nothing allocates a
		// second entry for a label while a tombstoned one survives, because of
		// rule R itself. Pinned so a hand-edited or future-build file resolves to
		// the most recently allocated rows rather than the oldest.
		writeRegistry({
			formatVersion: 1,
			nextId: 9,
			branches: [
				entry(3, "main", { deletedAt: new Date(T0 - 5000).toISOString() }),
				entry(7, "main", { deletedAt: new Date(T0 - 1000).toISOString() }),
			],
		});
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("main"))).toBe(7);
	});
});

describe("rule C (§3.4): finalizeTombstone drops the entry and leaves nextId alone", () => {
	test("a drained tombstone is dropped; nextId does not move", () => {
		writeRegistry({
			formatVersion: 1,
			nextId: 3,
			branches: [
				entry(1, "main"),
				entry(2, "gone", { deletedAt: new Date(T0).toISOString() }),
			],
		});
		const registry = openRegistry(loc, lock, noRows);
		registry.finalizeTombstone(2, 0);
		registry.flush();

		const file = onDisk();
		expect(file.branches.map((b) => b.id)).toEqual([1]);
		// "Never reused" is a property of nextId alone.
		expect(file.nextId).toBe(3);
	});

	test("it REFUSES an entry whose membership has not drained", () => {
		writeRegistry({
			formatVersion: 1,
			nextId: 3,
			branches: [entry(2, "gone", { deletedAt: new Date(T0).toISOString() })],
		});
		const registry = openRegistry(loc, lock, noRows);
		// The proof is COMPARED, not merely declared (CLAUDE.md #32).
		expect(() => registry.finalizeTombstone(2, 1)).toThrow(/still has 1/);
		registry.flush();
		expect(onDisk().branches).toHaveLength(1);
	});

	test("it REFUSES a live entry", () => {
		const registry = openRegistry(loc, lock, noRows);
		registry.resolveId(branch("main"));
		expect(() => registry.finalizeTombstone(1, 0)).toThrow(/not tombstoned/);
	});
});

describe("a failed allocation rename is undone in memory", () => {
	test("the failed label's id is issued to the next allocation, not skipped or published", () => {
		if (process.getuid?.() === 0) return; // root ignores directory permissions
		const registry = openRegistry(loc, lock, noRows);
		expect(registry.resolveId(branch("main"))).toBe(1);

		chmodSync(loc.storeDir, 0o500);
		try {
			expect(() => registry.resolveId(branch("doomed"))).toThrow();
		} finally {
			chmodSync(loc.storeDir, 0o700);
		}

		registry.flush();
		expect(onDisk().branches.map((b) => b.label)).toEqual(["main"]);
		expect(registry.resolveId(branch("next"))).toBe(2);
		expect(onDisk().branches.map((b) => [b.id, b.label])).toEqual([
			[1, "main"],
			[2, "next"],
		]);
	});
});
