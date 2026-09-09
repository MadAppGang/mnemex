/**
 * Index Version Registry
 *
 * Single source of truth for index version semantics.
 * Maps version numbers to feature sets and provides upgrade detection.
 */

import { loadProjectConfig, saveProjectConfig } from "../config.js";

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
] as const;

/**
 * v2 -> v3 is a SCHEMA change, not just a feature flag.
 *
 * LanceDB infers the Arrow schema from the first batch written to a table and
 * never declares it, so a v2 index has a 22-column schema on disk and a v3
 * write carries 23 fields (`StoredChunk.embedKey`). Those cannot be mixed: the
 * version is what lets the indexer notice the difference and rebuild once,
 * rather than letting a v3 batch reach a live v2 table.
 *
 * The cost of that rebuild is one full re-embed, per repository, once — which
 * is why `getUpgradeMessage` says so out loud.
 */
export const CURRENT_INDEX_VERSION = 3;

/** Human-readable labels for feature identifiers */
const FEATURE_DESCRIPTIONS: Record<string, string> = {
	ast_metadata:
		"AST metadata (function params, return types, async/exported flags)",
	hierarchical_units: "Hierarchical code units (file > class > method)",
	code_unit_search: "AST-aware search results",
	embedding_cache_audit:
		"Embedding-cache key on each row (cache hit-rate audit)",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the index version from .mnemex/config.json.
 * Returns 1 (implicit) when no version is stored (old index).
 */
export function getIndexVersion(projectPath: string): number {
	try {
		const config = loadProjectConfig(projectPath);
		return config?.indexVersion ?? 1;
	} catch {
		return 1;
	}
}

/**
 * Write the index version to .mnemex/config.json.
 * Merges with existing config (non-destructive).
 */
export function setIndexVersion(projectPath: string, version: number): void {
	saveProjectConfig(projectPath, { indexVersion: version });
}

/**
 * Returns true when the stored version is older than CURRENT_INDEX_VERSION.
 * Fast: reads config.json only, no DB access.
 */
export function needsUpgrade(projectPath: string): boolean {
	return getIndexVersion(projectPath) < CURRENT_INDEX_VERSION;
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
 * Example output:
 *   Index outdated (v2 -> v3). Missing features:
 *     - Embedding-cache key on each row (cache hit-rate audit)
 *   Run 'mnemex index' to upgrade (the next index run rebuilds automatically, re-embedding once).
 */
export function getUpgradeMessage(projectPath: string): string | null {
	const currentVersion = getIndexVersion(projectPath);
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

	// NOT "--force". From v3 onwards the indexer detects an out-of-shape table
	// itself (a live `hasEmbedKeyColumn()` read) and sets force for that run, so
	// asking the user for the flag would be telling them to do something the run
	// already does. The re-embed is named because the user pays for it: on a
	// paid provider this line is the only warning before money is spent.
	lines.push(
		"Run 'mnemex index' to upgrade (the next index run rebuilds automatically, re-embedding once).",
	);

	return lines.join("\n");
}

/**
 * Convenience: call getUpgradeMessage and print to stderr if non-null.
 * Used at the start of read-only commands.
 */
export function warnIfOutdated(projectPath: string): void {
	const message = getUpgradeMessage(projectPath);
	if (message) {
		process.stderr.write(`${message}\n`);
	}
}

/**
 * Returns an upgrade warning string if the index is outdated, null otherwise.
 * Exported for use in CLI handlers.
 */
export function checkIndexVersion(projectPath: string): string | null {
	return getUpgradeMessage(projectPath);
}
