/**
 * Index version registry: the v3 -> v4 bump, and the version's move into the
 * store's own `store.json`.
 *
 * v4 is a schema change on both halves of the store. A v4 LanceDB batch
 * carries 25 fields (`branchIds`, `pathKind`), and 0.38 rejects it against a
 * 23-column v3 table (`Found field not in schema`; `store-v4-schema.test.ts`
 * pins that). `files` changes its primary key to `(branch_id, path)`, which
 * no ALTER can do. The version is the first of three signals the indexer reads
 * before it writes (architecture §6.1).
 *
 * Since v4 the version lives in `<storeDir>/store.json`, not in the
 * per-worktree `config.json`: two worktrees that share a store must agree
 * about its version (§3.6). The legacy `config.json` stamp is read by exactly
 * one function, `probeOldStore`, which says `null` and never 1 for an index
 * that records no version, so a fresh clone cannot report
 * `upgraded_from_index_version=1` (V4.6, V4.8).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClockForTests } from "../../../src/core/clock.js";
import {
	CURRENT_INDEX_VERSION,
	getIndexVersion,
	getMissingFeatures,
	getUpgradeMessage,
	INDEX_VERSIONS,
	needsUpgrade,
	setIndexVersion,
} from "../../../src/core/index-version.js";
import {
	__resetStoreLocationCacheForTests,
	resolveStoreLocation,
	type StoreLocation,
} from "../../../src/core/store-location.js";
import { probeOldStore } from "../../../src/core/store-meta.js";

const T0 = Date.UTC(2026, 8, 15, 9, 30, 0);

let projectPath: string;
let loc: StoreLocation;

beforeEach(() => {
	projectPath = mkdtempSync(join(tmpdir(), "mnemex-index-version-"));
	__resetStoreLocationCacheForTests();
	loc = resolveStoreLocation(projectPath);
	__setClockForTests(() => T0);
});

afterEach(() => {
	__setClockForTests(null);
	rmSync(projectPath, { recursive: true, force: true });
});

/**
 * Stamp a store the way a pre-v4 build did: straight into `.mnemex/config.json`
 * beside the index, never into `store.json`.
 */
function stampLegacyVersion(version: number, extra: object = {}): string {
	mkdirSync(loc.storeDir, { recursive: true });
	const text = JSON.stringify({ indexVersion: version, ...extra }, null, 2);
	writeFileSync(join(loc.storeDir, "config.json"), text, "utf-8");
	return text;
}

function storeJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(loc.storeDir, "store.json"), "utf-8"));
}

// ============================================================================
// The registry itself
// ============================================================================

describe("INDEX_VERSIONS registry", () => {
	test("carries the v4 entry that names repo-relative paths and branch membership", () => {
		const v4 = INDEX_VERSIONS.find((v) => v.version === 4);
		expect(v4).toBeDefined();
		expect(v4?.name).toBe("repo_stable_branch_membership");
		expect(v4?.features).toContain("repo_relative_paths");
		expect(v4?.features).toContain("branch_membership");
	});

	test("still carries the v3 entry", () => {
		const v3 = INDEX_VERSIONS.find((v) => v.version === 3);
		expect(v3?.name).toBe("embed_key_column");
	});

	/** I-14: the code-unit id carries the unit's content since v5. */
	test("carries the v5 entry that names content-addressed code units", () => {
		const v5 = INDEX_VERSIONS.find((v) => v.version === 5);
		expect(v5).toBeDefined();
		expect(v5?.name).toBe("content_addressed_code_units");
		expect(v5?.features).toContain("content_addressed_code_units");
	});

	/** Catches the bump and the entry going in separately, in EITHER order. */
	test("CURRENT_INDEX_VERSION is 5 and the highest version in the registry", () => {
		const highest = Math.max(...INDEX_VERSIONS.map((v) => v.version));
		expect(CURRENT_INDEX_VERSION).toBe(highest);
		expect(CURRENT_INDEX_VERSION).toBe(5);
	});

	test("versions are contiguous from 1, so no upgrade step is skippable", () => {
		const versions = INDEX_VERSIONS.map((v) => v.version);
		expect(versions).toEqual(
			Array.from({ length: versions.length }, (_, i) => i + 1),
		);
	});

	/**
	 * A version may only ADD features. `getMissingFeatures` diffs the newest
	 * entry against the stored one, so a feature dropped from a later entry
	 * silently stops being reported as missing for every older index.
	 */
	test("each version's features are a superset of the previous version's", () => {
		for (let i = 1; i < INDEX_VERSIONS.length; i++) {
			const previous = new Set(INDEX_VERSIONS[i - 1].features);
			const current = new Set(INDEX_VERSIONS[i].features);
			expect([...previous].filter((f) => !current.has(f))).toEqual([]);
		}
	});

	test("every feature in the current version has a human-readable description", () => {
		// A feature with no description falls back to its snake_case identifier,
		// which is what this catches.
		stampLegacyVersion(1);
		const message = getUpgradeMessage(loc);
		expect(message).not.toBeNull();
		for (const feature of getMissingFeatures(1)) {
			expect(message).not.toContain(`  - ${feature}\n`);
		}
	});
});

// ============================================================================
// Detection: a pre-v4 store needs an upgrade
// ============================================================================

describe("a v3 store is detected as needing an upgrade", () => {
	test("needsUpgrade reads the legacy config.json stamp of a store that has no store.json", () => {
		stampLegacyVersion(3);
		expect(getIndexVersion(loc)).toBe(3);
		expect(needsUpgrade(loc)).toBe(true);
	});

	/** v4's three plus v5's one (I-14) — every step between 3 and today. */
	test("the missing features are exactly v4's three and v5's one", () => {
		expect(getMissingFeatures(3)).toEqual([
			"repo_relative_paths",
			"branch_membership",
			"shared_repo_store",
			"content_addressed_code_units",
		]);
	});

	test("the message names the step, and a v3 store's cost: a rebuild out of the embedding cache", () => {
		stampLegacyVersion(3);
		const message = getUpgradeMessage(loc) ?? "";
		expect(message).toContain("Index outdated (v3 -> v5)");
		expect(message).toContain("relative to the repository");
		expect(message).toContain("served from the embedding cache");
		expect(message).not.toContain("re-embedding");
	});

	/**
	 * A store older than v3 was never built through the embedding cache, so it
	 * DOES re-embed, and on a metered provider this line is the only warning
	 * an unattended run gives before spending it.
	 */
	test("a v2 store's message still states the re-embed", () => {
		stampLegacyVersion(2);
		const message = getUpgradeMessage(loc) ?? "";
		expect(message).toContain("Index outdated (v2 -> v5)");
		expect(message).toContain("re-embedding once");
		expect(message).not.toContain("served from the embedding cache");
	});

	test("the message does NOT tell the user to pass --force", () => {
		stampLegacyVersion(3);
		const message = getUpgradeMessage(loc) ?? "";
		expect(message).toContain("Run 'mnemex index' to upgrade");
		expect(message).not.toContain("--force");
	});

	test("an unstamped store reads as the implicit v1 on the WARNING surfaces", () => {
		expect(getIndexVersion(loc)).toBe(1);
		expect(needsUpgrade(loc)).toBe(true);
	});
});

// ============================================================================
// The stamp: store.json, beside the data it describes
// ============================================================================

describe("setIndexVersion writes store.json, never config.json", () => {
	test("a current stamp clears the upgrade, and lands in store.json", () => {
		setIndexVersion(loc, CURRENT_INDEX_VERSION);
		expect(getIndexVersion(loc)).toBe(5);
		expect(needsUpgrade(loc)).toBe(false);
		expect(getUpgradeMessage(loc)).toBeNull();
		expect(storeJson().indexVersion).toBe(5);
		expect(existsSync(join(loc.storeDir, "config.json"))).toBe(false);
	});

	test("a legacy config.json is left byte-for-byte alone, and store.json wins over its stale stamp", () => {
		const legacy = stampLegacyVersion(3, {
			vector: false,
			indexDir: ".mnemex",
		});
		setIndexVersion(loc, CURRENT_INDEX_VERSION);
		expect(readFileSync(join(loc.storeDir, "config.json"), "utf-8")).toBe(
			legacy,
		);
		expect(getIndexVersion(loc)).toBe(5);
	});

	test("store.json carries §3.6's fields, and no pathRoot", () => {
		setIndexVersion(loc, CURRENT_INDEX_VERSION);
		const meta = storeJson();
		expect(meta.formatVersion).toBe(1);
		expect(meta.indexVersion).toBe(5);
		// No git layout here, so there is no clone identity to record.
		expect(meta.gitCommonDir).toBeNull();
		expect(meta.firstIndexedFrom).toBe(loc.pathRoot);
		expect(meta.updatedAt).toBe(new Date(T0).toISOString());
		expect(meta).not.toHaveProperty("pathRoot");
	});

	test("a later stamp keeps firstIndexedFrom and any field it does not know", () => {
		setIndexVersion(loc, CURRENT_INDEX_VERSION);
		const path = join(loc.storeDir, "store.json");
		writeFileSync(
			path,
			JSON.stringify({
				...storeJson(),
				firstIndexedFrom: "/elsewhere",
				confirmRunCounter: 7,
			}),
		);
		__setClockForTests(() => T0 + 1000);
		setIndexVersion(loc, CURRENT_INDEX_VERSION);
		const meta = storeJson();
		expect(meta.firstIndexedFrom).toBe("/elsewhere");
		expect(meta.confirmRunCounter).toBe(7);
		expect(meta.updatedAt).toBe(new Date(T0 + 1000).toISOString());
	});
});

// ============================================================================
// probeOldStore: the one sanctioned reader of the legacy stamp
// ============================================================================

describe("probeOldStore", () => {
	test("a directory that does not exist is not a store", () => {
		expect(probeOldStore(join(projectPath, "nope"))).toEqual({ exists: false });
	});

	test("a directory holding only a lock file and a cache tag is not a store", () => {
		mkdirSync(loc.storeDir, { recursive: true });
		writeFileSync(join(loc.storeDir, ".indexing.lock"), "{}");
		writeFileSync(join(loc.storeDir, "CACHEDIR.TAG"), "Signature");
		expect(probeOldStore(loc.storeDir)).toEqual({ exists: false });
	});

	test("an index.db that records no version is a store of UNKNOWN version: null, never 1", () => {
		mkdirSync(loc.storeDir, { recursive: true });
		writeFileSync(join(loc.storeDir, "index.db"), "");
		writeFileSync(
			join(loc.storeDir, "config.json"),
			JSON.stringify({ vector: false }),
		);
		expect(probeOldStore(loc.storeDir)).toEqual({
			exists: true,
			recordedVersion: null,
		});
	});

	test("the legacy config.json stamp is read", () => {
		stampLegacyVersion(3);
		expect(probeOldStore(loc.storeDir)).toEqual({
			exists: true,
			recordedVersion: 3,
		});
	});

	test("store.json is read first", () => {
		stampLegacyVersion(3);
		setIndexVersion(loc, 4);
		expect(probeOldStore(loc.storeDir)).toEqual({
			exists: true,
			recordedVersion: 4,
		});
	});
});
