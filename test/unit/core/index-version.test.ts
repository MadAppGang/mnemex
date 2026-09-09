/**
 * Index version registry — the v2 -> v3 bump.
 *
 * v3 is not a cosmetic version number. LanceDB infers a table's Arrow schema
 * from the first batch written to it and never declares it (CLAUDE.md #15 is
 * the scar tissue from the other consequence of that fact), so a v2 index has a
 * 22-column schema on disk while a v3 write carries 23 fields
 * (`StoredChunk.embedKey`). Measured against the installed LanceDB 0.38, a
 * 23-field batch aimed at a 22-column table fails with
 *
 *     Found field not in schema: embedKey at row 0
 *
 * — see `store-embed-key-column.test.ts`, which pins that as a fixture. The
 * version is the ONLY thing that lets the indexer notice the difference before
 * it writes, which is why the column and the bump cannot land separately.
 *
 * These tests are written to be RED on a tree that has the column but not the
 * bump: `needsUpgrade` on a v2 project, `getMissingFeatures(2)` and
 * `getUpgradeMessage` all answer "up to date" while `CURRENT_INDEX_VERSION` is
 * still 2.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURRENT_INDEX_VERSION,
	getIndexVersion,
	getMissingFeatures,
	getUpgradeMessage,
	INDEX_VERSIONS,
	needsUpgrade,
	setIndexVersion,
} from "../../../src/core/index-version.js";

let projectPath: string;

beforeEach(() => {
	projectPath = mkdtempSync(join(tmpdir(), "mnemex-index-version-"));
});

afterEach(() => {
	rmSync(projectPath, { recursive: true, force: true });
});

/**
 * Stamp a project the way a build of that vintage would have: straight into
 * `.mnemex/config.json`, without going through today's `setIndexVersion`.
 */
function stampIndexVersion(version: number): void {
	mkdirSync(join(projectPath, ".mnemex"), { recursive: true });
	writeFileSync(
		join(projectPath, ".mnemex", "config.json"),
		JSON.stringify({ indexVersion: version }, null, 2),
		"utf-8",
	);
}

// ============================================================================
// The registry itself
// ============================================================================

describe("INDEX_VERSIONS registry", () => {
	test("carries the v3 entry that names the embedKey column", () => {
		const v3 = INDEX_VERSIONS.find((v) => v.version === 3);
		expect(v3).toBeDefined();
		expect(v3?.name).toBe("embed_key_column");
		expect(v3?.features).toContain("embedding_cache_audit");
	});

	/**
	 * Structural, and it catches the bump and the entry going in separately in
	 * EITHER order: an entry with no bump, or a bump with no entry.
	 */
	test("CURRENT_INDEX_VERSION is the highest version in the registry", () => {
		const highest = Math.max(...INDEX_VERSIONS.map((v) => v.version));
		expect(CURRENT_INDEX_VERSION).toBe(highest);
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
			const dropped = [...previous].filter((f) => !current.has(f));
			expect(dropped).toEqual([]);
		}
	});

	test("every feature in the current version has a human-readable description", () => {
		// Read through the public surface: getMissingFeatures(1) returns every
		// feature v1 lacks, and getUpgradeMessage renders each one. A feature
		// with no description falls back to its raw identifier, which is what
		// this catches — identifiers are snake_case with no spaces.
		stampIndexVersion(1);
		const message = getUpgradeMessage(projectPath);
		expect(message).not.toBeNull();
		for (const feature of getMissingFeatures(1)) {
			expect(message).not.toContain(`  - ${feature}\n`);
		}
	});
});

// ============================================================================
// Detection — a v2 index needs an upgrade
// ============================================================================

describe("a v2 index is detected as needing an upgrade", () => {
	test("needsUpgrade is true for an index stamped v2", () => {
		stampIndexVersion(2);
		expect(getIndexVersion(projectPath)).toBe(2);
		expect(needsUpgrade(projectPath)).toBe(true);
	});

	test("the missing feature is exactly the embedding-cache audit column", () => {
		expect(getMissingFeatures(2)).toEqual(["embedding_cache_audit"]);
	});

	test("the upgrade message names the version step and the feature", () => {
		stampIndexVersion(2);
		const message = getUpgradeMessage(projectPath);
		expect(message).not.toBeNull();
		expect(message).toContain("Index outdated (v2 -> v3)");
		expect(message).toContain("Embedding-cache key on each row");
	});

	/**
	 * The re-embed is what the user PAYS for on a metered provider, and this
	 * line is the only warning that reaches them before an unattended run (a
	 * watch daemon, a post-commit hook, or the MCP auto-reindex) spends it.
	 */
	test("the upgrade message states the cost — one rebuild that re-embeds", () => {
		stampIndexVersion(2);
		const message = getUpgradeMessage(projectPath) ?? "";
		expect(message).toContain("re-embedding once");
		expect(message).toContain("rebuilds automatically");
	});

	/**
	 * `--force` is no longer the instruction: from v3 the indexer reads the live
	 * table shape and forces the rebuild itself. Telling the user to pass a flag
	 * the run already applies is wrong advice, not merely redundant.
	 */
	test("the upgrade message does NOT tell the user to pass --force", () => {
		stampIndexVersion(2);
		const message = getUpgradeMessage(projectPath) ?? "";
		expect(message).toContain("Run 'mnemex index' to upgrade");
		expect(message).not.toContain("--force");
	});

	test("an unstamped index is implicitly v1 and needs the whole ladder", () => {
		expect(getIndexVersion(projectPath)).toBe(1);
		expect(needsUpgrade(projectPath)).toBe(true);
		expect(getMissingFeatures(1)).toContain("hierarchical_units");
		expect(getMissingFeatures(1)).toContain("embedding_cache_audit");
	});
});

// ============================================================================
// A fresh index is created at v3
// ============================================================================

describe("a fresh index is stamped v3", () => {
	/**
	 * `indexer.ts` stamps `CURRENT_INDEX_VERSION` unconditionally at the end of
	 * a completed run. This is that write and read back, so the stamp a fresh
	 * index actually receives is asserted rather than assumed.
	 */
	test("setIndexVersion(CURRENT_INDEX_VERSION) writes 3 and clears the upgrade", () => {
		setIndexVersion(projectPath, CURRENT_INDEX_VERSION);
		expect(getIndexVersion(projectPath)).toBe(3);
		expect(needsUpgrade(projectPath)).toBe(false);
		expect(getUpgradeMessage(projectPath)).toBeNull();
	});

	test("stamping v2 does NOT clear the upgrade — the bump is what moves it", () => {
		setIndexVersion(projectPath, 2);
		expect(needsUpgrade(projectPath)).toBe(true);
		expect(getUpgradeMessage(projectPath)).not.toBeNull();
	});

	test("the stamp is non-destructive: other project config survives", () => {
		mkdirSync(join(projectPath, ".mnemex"), { recursive: true });
		writeFileSync(
			join(projectPath, ".mnemex", "config.json"),
			JSON.stringify({ indexVersion: 2, vector: false, indexDir: ".mnemex" }),
			"utf-8",
		);
		setIndexVersion(projectPath, CURRENT_INDEX_VERSION);
		expect(getIndexVersion(projectPath)).toBe(3);
		// Read through the same file the stamp merged into.
		const raw = JSON.parse(
			readFileSync(join(projectPath, ".mnemex", "config.json"), "utf-8"),
		);
		expect(raw.vector).toBe(false);
		expect(raw.indexDir).toBe(".mnemex");
	});
});
