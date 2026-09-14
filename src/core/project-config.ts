/**
 * Project-level configuration: the `mnemex.json` / `.mnemex/config.json` reader
 * and writer, and the per-project path constants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTED from `src/config.ts`, and a MOVE, not a rewrite.
 *
 * `src/core/store-location.ts` needs `ProjectConfig.indexDir`, whose reader
 * lived in `src/config.ts`, and `src/config.ts` will delegate its path
 * functions to the seam. Leaving the reader where it was makes an import cycle
 * (architecture §2.3, "Circular import"). This file is the leaf both of them
 * import downward. `src/config.ts` re-exports every symbol here under its old
 * name, so no caller changes.
 *
 * The one departure from a verbatim move is the save listener. The old
 * `saveProjectConfig` called `resetLearningEnabledCache()` directly, and that
 * cache lives in `src/config.ts`. Importing it here would recreate the cycle,
 * so `src/config.ts` registers its reset through `onProjectConfigSaved()` at
 * module scope. That keeps the old behaviour exactly: the cache exists only
 * once `src/config.ts` has been evaluated, and evaluating it registers the
 * reset.
 *
 * IMPORT ALLOWLIST: `node:fs`, `node:path`, and a TYPE-ONLY import of
 * `../types.js`, and NOTHING ELSE. In particular nothing that can reach
 * `src/config.ts`, `src/core/secrets.ts` or `src/core/keychain.ts`. Resolving
 * where a store lives must never cost a credential read (NFR-2, CLAUDE.md #24,
 * #27). Enforced by `test/unit/core/store-location-imports.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Project config directory name */
export const PROJECT_CONFIG_DIR = ".mnemex";

/** Project config file name (inside .mnemex/) */
export const PROJECT_CONFIG_FILE = "config.json";

/** Project config file at root (simpler alternative) */
export const PROJECT_ROOT_CONFIG_FILE = "mnemex.json";

/** Index database file name */
export const INDEX_DB_FILE = "index.db";

/** Vector store directory name */
export const VECTORS_DIR = "vectors";

// ============================================================================
// Read
// ============================================================================

/**
 * Load project configuration
 * Checks: 1) mnemex.json (root), 2) .mnemex/config.json
 */
export function loadProjectConfig(projectPath: string): ProjectConfig | null {
	// First try mnemex.json at project root (preferred, simpler)
	const rootConfigPath = join(projectPath, PROJECT_ROOT_CONFIG_FILE);
	if (existsSync(rootConfigPath)) {
		try {
			const content = readFileSync(rootConfigPath, "utf-8");
			return JSON.parse(content) as ProjectConfig;
		} catch (error) {
			console.warn("Failed to load mnemex.json:", error);
		}
	}

	// Fall back to .mnemex/config.json
	const configPath = join(projectPath, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
	if (existsSync(configPath)) {
		try {
			const content = readFileSync(configPath, "utf-8");
			return JSON.parse(content) as ProjectConfig;
		} catch (error) {
			console.warn("Failed to load .mnemex/config.json:", error);
		}
	}

	return null;
}

// ============================================================================
// Write
// ============================================================================

/**
 * Called after every successful `saveProjectConfig`. A Set, not a single slot,
 * so a second registrant cannot silently evict the first one: if one slot held
 * both the learning-cache reset and some later cache's reset, the later one
 * would win and in-process learning rewrites would go stale without an error.
 */
const projectConfigSavedListeners = new Set<() => void>();

/**
 * Run `listener` after every successful `saveProjectConfig`.
 *
 * For caches keyed on project config that live in modules this leaf must not
 * import. Registering the same function twice registers it once. Returns an
 * unsubscribe function.
 */
export function onProjectConfigSaved(listener: () => void): () => void {
	projectConfigSavedListeners.add(listener);
	return () => {
		projectConfigSavedListeners.delete(listener);
	};
}

/**
 * Save project configuration
 */
export function saveProjectConfig(
	projectPath: string,
	config: Partial<ProjectConfig>,
): void {
	const configDir = join(projectPath, PROJECT_CONFIG_DIR);
	const configPath = join(configDir, PROJECT_CONFIG_FILE);

	// Ensure directory exists
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Merge with existing config
	const existing = loadProjectConfig(projectPath) || {
		excludePatterns: [],
		includePatterns: [],
	};
	const merged = { ...existing, ...config };

	writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");

	// Caches keyed on project config must see the rewrite. The learning
	// decision is cached per path in `src/config.ts`, which registers its reset
	// here (see the file header for why it is not a direct call).
	for (const listener of projectConfigSavedListeners) listener();
}
