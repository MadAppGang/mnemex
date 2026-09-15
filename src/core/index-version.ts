/**
 * Index Version Registry
 *
 * Single source of truth for index version semantics.
 * Maps version numbers to feature sets and provides upgrade detection.
 *
 * Since index version 4 the version lives in the store's own `store.json`,
 * not in the per-worktree `config.json` (architecture §3.6). Two worktrees
 * that share one store must agree about its version. Per-worktree stamps
 * would have each worktree force-rebuild the other forever.
 */

import type { StoreLocation } from "./store-location.js";
import { probeOldStore, writeStoreMeta } from "./store-meta.js";

// ============================================================================
// Version Registry
// ============================================================================

export interface VersionEntry {
	version: number;
	name: string;
	description: string;
	features: string[];
}

export const INDEX_VERSIONS: readonly VersionEntry[] = [
	{
		version: 1,
		name: "basic_chunks",
		description: "Flat code chunks with vector + BM25 search",
		features: ["vector_search", "bm25_search", "symbol_graph"],
	},
	{
		version: 2,
		name: "code_units",
		description: "Hierarchical code units with AST metadata",
		features: [
			"vector_search",
			"bm25_search",
			"symbol_graph",
			"ast_metadata",
			"hierarchical_units",
			"code_unit_search",
		],
	},
	{
		version: 3,
		name: "embed_key_column",
		description: "Rows carry the embedding-cache key for audit",
		features: [
			"vector_search",
			"bm25_search",
			"symbol_graph",
			"ast_metadata",
			"hierarchical_units",
			"code_unit_search",
			"embedding_cache_audit",
		],
	},
	{
		version: 4,
		name: "repo_stable_branch_membership",
		description:
			"Repo-relative paths and per-row branch membership; one store per repository",
		features: [
			"vector_search",
			"bm25_search",
			"symbol_graph",
			"ast_metadata",
			"hierarchical_units",
			"code_unit_search",
			"embedding_cache_audit",
			"repo_relative_paths",
			"branch_membership",
			"shared_repo_store",
		],
	},
	{
		version: 5,
		name: "content_addressed_code_units",
		description:
			"Code-unit ids hash the unit's content, so two branches' revisions of one unit are two rows",
		features: [
			"vector_search",
			"bm25_search",
			"symbol_graph",
			"ast_metadata",
			"hierarchical_units",
			"code_unit_search",
			"embedding_cache_audit",
			"repo_relative_paths",
			"branch_membership",
			"shared_repo_store",
			"content_addressed_code_units",
		],
	},
] as const;

/**
 * v3 -> v4 is a SCHEMA change, on both halves of the store.
 *
 * LanceDB: a v4 batch carries 25 fields (`branchIds`, `pathKind`) and a live v3
 * table has 23 columns, and 0.38 rejects the whole `add` with
 * `Found field not in schema`. SQLite: `files` changes its primary key to
 * `(branch_id, path)`, which no `ALTER TABLE` can do. And every stored path
 * changes meaning, from absolute to repo-relative, which changes every chunk id.
 *
 * So the upgrade is a plain rebuild, once (CLAUDE.md #31: no seeding pass). The
 * embedding cache is keyed on text, not on path, so re-chunking a tree that
 * was indexed with the cache on is served from it.
 *
 * v4 -> v5 is a STORED-ID change, not a schema change (I-14). `codeUnitRowId`
 * now hashes the unit's content, so every `code_unit` id in a v4 store names a
 * row the new code would never produce. Nothing rejects those rows — that is
 * the danger: they would be tier-1 MISSES, the run would insert the new ids
 * beside them, and the old rows would be stranded with live membership, which
 * is stale code-unit results with `store.json` reading "current". The rebuild
 * is what removes them, and it needs no new migration branch: the trigger is
 * `oldStore.recordedVersion < CURRENT_INDEX_VERSION` (`indexer.ts`), a generic
 * comparison. v4 is unreleased, so the only stores this moves belong to whoever
 * is working on this build, and everyone upgrading rebuilds once either way.
 */
export const CURRENT_INDEX_VERSION = 5;

/**
 * The first index version built through the embedding cache (it added the
 * `embedKey` column). A store at least this new rebuilds out of the cache; an
 * older one re-embeds.
 */
export const FIRST_EMBED_CACHE_INDEX_VERSION = 3;

/** Human-readable labels for feature identifiers */
const FEATURE_DESCRIPTIONS: Record<string, string> = {
	ast_metadata:
		"AST metadata (function params, return types, async/exported flags)",
	hierarchical_units: "Hierarchical code units (file > class > method)",
	code_unit_search: "AST-aware search results",
	embedding_cache_audit:
		"Embedding-cache key on each row (cache hit-rate audit)",
	repo_relative_paths:
		"Paths stored relative to the repository, so any worktree can read them",
	branch_membership: "Per-row branch membership",
	shared_repo_store: "One index per repository, shared by its worktrees",
	content_addressed_code_units:
		"Code-unit ids carry the unit's content, so branches do not share one body",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * The version the store at `loc` was built with.
 *
 * Reads `store.json`. A store written before v4 has none, and for it this falls
 * back to the legacy `config.json` stamp through `probeOldStore`, the one
 * sanctioned reader of that stamp. Returns 1 when neither records a version:
 * the implicit version of an index older than versioning, which every warning
 * surface compared against before v4.
 *
 * The UPGRADE REPORT does not use this. `upgradedFromIndexVersion` comes from
 * `probeOldStore`, where "unrecorded" is `null` and never 1 (§6.1, V4.8).
 */
export function getIndexVersion(loc: StoreLocation): number {
	const probe = probeOldStore(loc.storeDir);
	return probe.exists ? (probe.recordedVersion ?? 1) : 1;
}

/**
 * Record the version in `store.json`, beside the data it describes. Call only
 * while holding the store lock.
 */
export function setIndexVersion(loc: StoreLocation, version: number): void {
	writeStoreMeta(loc, { indexVersion: version });
}

/**
 * Returns true when the stored version is older than CURRENT_INDEX_VERSION.
 * Fast: reads two small JSON files, no DB access.
 */
export function needsUpgrade(loc: StoreLocation): boolean {
	return getIndexVersion(loc) < CURRENT_INDEX_VERSION;
}

/**
 * Returns the feature names present in CURRENT_INDEX_VERSION but absent in currentVersion.
 * Used to build the upgrade warning message.
 */
export function getMissingFeatures(currentVersion: number): string[] {
	const currentEntry = INDEX_VERSIONS.find((v) => v.version === currentVersion);
	const latestEntry = INDEX_VERSIONS.find(
		(v) => v.version === CURRENT_INDEX_VERSION,
	);

	if (!latestEntry) return [];
	if (!currentEntry) return [...latestEntry.features];

	const currentFeatures = new Set(currentEntry.features);
	return latestEntry.features.filter((f) => !currentFeatures.has(f));
}

/**
 * Returns a formatted multi-line upgrade warning string, or null if up to date.
 * Callers should print this to stderr.
 *
 * Example output (from a v3 store):
 *   Index outdated (v3 -> v4). Missing features:
 *     - Paths stored relative to the repository, so any worktree can read them
 *     - Per-row branch membership
 *     - One index per repository, shared by its worktrees
 *   Run 'mnemex index' to upgrade (the next index run rebuilds once, served from the embedding cache).
 */
export function getUpgradeMessage(loc: StoreLocation): string | null {
	const currentVersion = getIndexVersion(loc);
	if (currentVersion >= CURRENT_INDEX_VERSION) return null;

	const missingFeatures = getMissingFeatures(currentVersion);
	if (missingFeatures.length === 0) return null;

	const lines: string[] = [
		`Index outdated (v${currentVersion} -> v${CURRENT_INDEX_VERSION}). Missing features:`,
	];

	for (const feature of missingFeatures) {
		const description = FEATURE_DESCRIPTIONS[feature] ?? feature;
		lines.push(`  - ${description}`);
	}

	// NOT "--force". The indexer detects an out-of-shape store itself (a live
	// schema read on each half) and rebuilds for that run, so asking the user
	// for the flag would tell them to do something the run already does.
	//
	// The cost is named because the user pays it. A store built through the
	// embedding cache (v3+) rebuilds out of it, since the cache is keyed on
	// text, not path. An older one never filled the cache, so it re-embeds, and
	// on a paid provider this line is the only warning before money is spent.
	lines.push(
		currentVersion >= FIRST_EMBED_CACHE_INDEX_VERSION
			? "Run 'mnemex index' to upgrade (the next index run rebuilds once, served from the embedding cache)."
			: "Run 'mnemex index' to upgrade (the next index run rebuilds automatically, re-embedding once).",
	);

	return lines.join("\n");
}

/**
 * Convenience: call getUpgradeMessage and print to stderr if non-null.
 * Used at the start of read-only commands.
 */
export function warnIfOutdated(loc: StoreLocation): void {
	const message = getUpgradeMessage(loc);
	if (message) {
		process.stderr.write(`${message}\n`);
	}
}

/**
 * Returns an upgrade warning string if the index is outdated, null otherwise.
 * Exported for use in CLI handlers.
 */
export function checkIndexVersion(loc: StoreLocation): string | null {
	return getUpgradeMessage(loc);
}
