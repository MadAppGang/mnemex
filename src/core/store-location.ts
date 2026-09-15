/**
 * THE seam: where does the index for this path live (FR-3)?
 *
 * Every path that computes an index directory is meant to come through
 * `resolveStoreLocation`, so one worktree cannot silently keep a store of its
 * own. Architecture §2.3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 1: NOTHING IN PRODUCTION CALLS THIS YET. Only tests do.
 *
 * ROW 3 IS GATED OFF until Phase 3c. `resolveStoreLocation` runs the
 * precedence with `STORE_SCOPE_DEFAULT = "worktree"`, so inside a repository
 * with no override the store stays `<startPath>/.mnemex` (kind
 * `worktree-local`), which is exactly today's `getIndexDir`. Phase 2 may wire
 * callers to this function and no store moves (§8). Phase 3c flips
 * `STORE_SCOPE_DEFAULT` to `"git-common-dir"`, and that one line is the whole
 * of 3c's precedence change. It must not land before 3b: a store shared while
 * its graph and tracker are not yet branch-scoped is a correctness regression
 * against today (§8, "Ordering within the release is forced").
 *
 * `pickStoreDir(inputs, scope)` is the precedence as a pure function. Tests
 * call it with each scope directly. There is deliberately NO setter for the
 * default: a test seam able to write a production default was a bypass once
 * already (CLAUDE.md #24). Production code calls `resolveStoreLocation`, and a
 * sweep in store-location-imports.test.ts keeps `pickStoreDir` out of `src/`.
 *
 * IMPORT ALLOWLIST: `node:fs`, `node:path`, `./git-layout.js`,
 * `./project-config.js`, and NOTHING ELSE (NFR-2). No embeddings client, no LLM
 * client, nothing that can reach `src/core/keychain.ts`. Resolving a directory
 * must cost no credential read (CLAUDE.md #24, #27). Pinned by
 * test/unit/core/store-location-imports.test.ts.
 *
 * NO SUBPROCESS (NFR-3): see `./git-layout.ts`.
 *
 * NEVER THROWS. Every input it reads is read through a function that degrades
 * instead of throwing: `readGitLayout` by contract, and the project config read
 * under its own `try`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Resolution is two ordered steps (§2.3). Revision 0's single table was
 * circular: a relative override was joined onto `pathRoot` before `pathRoot`
 * existed.
 *
 *   Step 1: the layout, unconditionally. `pathRoot` = the worktree root, or the
 *           start path outside a repository. An override NEVER moves it: an
 *           override relocates the store, not the path convention.
 *   Step 2: `storeDir` by precedence (`pickStoreDir`):
 *           1 MNEMEX_INDEX_DIR          absolute as-is, else join(pathRoot, v)   env-override
 *           2 ProjectConfig.indexDir    same rule, unless the literal ".mnemex"  config-override
 *           3 a git layout was found:
 *               scope "git-common-dir"  join(gitCommonDir, "mnemex")             git-common-dir
 *               scope "worktree"        join(startPath, ".mnemex")               worktree-local
 *           4 otherwise                 join(startPath, ".mnemex")               plain-directory
 *
 *           The scope affects row 3 only. Rows 1 and 2 are the same under both.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type GitLayout, readGitLayout } from "./git-layout.js";
import {
	INDEX_DB_FILE,
	loadProjectConfig,
	onProjectConfigSaved,
	PROJECT_CONFIG_DIR,
	PROJECT_CONFIG_FILE,
	VECTORS_DIR,
} from "./project-config.js";

export type StoreKind =
	| "git-common-dir" // <gitCommonDir>/mnemex — the default from Phase 3c on
	| "worktree-local" // <startPath>/.mnemex INSIDE a repository — the default until 3c
	| "config-override" // ProjectConfig.indexDir
	| "env-override" // MNEMEX_INDEX_DIR
	| "plain-directory"; // <startPath>/.mnemex OUTSIDE any repository — FR-7

/**
 * What row 3 does when a git layout was found and no override applies.
 *
 * `"worktree"`: the store stays per worktree (`worktree-local`), which is
 * today's behaviour and §8 Phase 2's promise. `"git-common-dir"`: every
 * worktree of the repository shares `<gitCommonDir>/mnemex`, which is FR-1 and
 * §8 Phase 3c.
 */
export type StoreScope = "worktree" | "git-common-dir";

/** Phase 3c flips this to "git-common-dir". That flip is the whole of 3c's precedence change. */
const STORE_SCOPE_DEFAULT: StoreScope = "worktree";

export interface StoreLocation {
	/** SHARED. Holds index.db, vectors/, branches.json, store.json, docs-cache/, .indexing.lock. */
	readonly storeDir: string;
	/** PER-WORKTREE `<pathRoot>/.mnemex`. Holds memories/, edit-history/, activity.jsonl, … */
	readonly worktreeDir: string;
	/** What EVERY stored filePath is relative TO. The worktree root, or startPath outside a repo. */
	readonly pathRoot: string;
	readonly kind: StoreKind;
	/** Present iff inside a repository; null otherwise. Re-read HEAD through this. */
	readonly gitLayout: GitLayout | null;
	/** Why we fell back, when we fell back inside something that looked like a repo. */
	readonly degradedReason: string | null;
	/** Set when ProjectConfig.indexDir held the literal old default and was ignored (D2). */
	readonly ignoredLegacyIndexDir: boolean;
	/**
	 * `MNEMEX_INDEX_DIR` exactly as the seam read it: not normalised, not made
	 * absolute, not realpath'd. `undefined` when unset; `""` stays `""` (row 1
	 * treats it as unset, but this field reports the input, not the decision).
	 *
	 * Exposed so nothing else has to read the variable: the seam is its ONE
	 * reader (decision I-8). Decision I-9 rebuilds HEAD's double-joined memory
	 * path from this exact string, and a normalised copy would name a directory
	 * HEAD never wrote. The memo is keyed on this same string, so a memoized
	 * location never reports another spelling's value.
	 */
	readonly envIndexDir: string | undefined;
}

/**
 * Everything Step 2 reads, already read. Produced by {@link readStoreInputs},
 * consumed by {@link pickStoreDir}. Splitting the reads from the decision is
 * what lets the decision be a pure function of its arguments.
 */
export interface StoreInputs {
	/** The canonical (realpath) start path. */
	readonly startPath: string;
	/** Step 1's result: present iff inside a repository. */
	readonly gitLayout: GitLayout | null;
	/** Why Step 1 found no layout inside something that looked like a repository. */
	readonly degradedReason: string | null;
	/** `MNEMEX_INDEX_DIR` as read; `undefined` when unset. */
	readonly envIndexDir: string | undefined;
	/**
	 * `ProjectConfig.indexDir` read at `pathRoot`, RAW: a hand-edited file can
	 * hold anything. `undefined` when there is no config or it could not be read.
	 */
	readonly configIndexDir: unknown;
}

/** Row 1 of the precedence. */
export const INDEX_DIR_ENV_VAR = "MNEMEX_INDEX_DIR";

/** Row 3: the store's directory name under the git common dir. */
export const GIT_STORE_DIR_NAME = "mnemex";

/**
 * D2: `ProjectConfig.indexDir` holding EXACTLY this string is treated as unset.
 *
 * It is the value the documentation told people to write, so it almost
 * certainly records a copied default rather than an intent to pin storage per
 * worktree. Compared with `===`, never after normalisation: `"./.mnemex"`,
 * `".mnemex/"` and backslash forms are HONOURED (V1.9, N25). A separate
 * constant from `PROJECT_CONFIG_DIR` on purpose: the literal in users' files
 * does not change if that constant ever does.
 */
export const LEGACY_DEFAULT_INDEX_DIR = ".mnemex";

/** The memo's bound, so a long-lived MCP server cannot grow it without limit (§2.5). */
export const STORE_LOCATION_CACHE_MAX = 64;

/** Same literal as `LOCK_FILENAME` in `./lock.ts`; this module may not import it. */
const LOCK_FILE = ".indexing.lock";
const DOCS_CACHE_DIR = "docs-cache";
const STORE_META_FILE = "store.json";
const BRANCH_REGISTRY_FILE = "branches.json";

/**
 * Memo keyed on `realpath(startPath)` AND the `MNEMEX_INDEX_DIR` value (unset
 * included), FIFO-evicted at {@link STORE_LOCATION_CACHE_MAX}. A module-level
 * `const` is the TypeScript Singleton (§1.3), keyed on real resource identity
 * rather than a per-instance flag (CLAUDE.md #21): the seam is called per
 * request, so dropping the memo would put a filesystem walk and a config read
 * back on every search.
 *
 * Invalidation, so the memo is never staler than today's unmemoized
 * `getIndexDir` for anything this process itself changes:
 *   - `MNEMEX_INDEX_DIR`: part of the key, so a changed value is a new entry.
 *   - `ProjectConfig.indexDir`: every `saveProjectConfig` clears the memo,
 *     through `onProjectConfigSaved` (registered below).
 *
 * What it still does NOT see, as a documented limit: a change to the `.git`
 * layout (`git init`, `git worktree add`/`prune`, a moved worktree) and a
 * project config file rewritten by ANOTHER process or by hand, after the first
 * resolution of a path in this process. `__resetStoreLocationCacheForTests()`
 * aside, only a restart picks those up.
 */
const locationCache = new Map<string, StoreLocation>();

function clearLocationCache(): void {
	locationCache.clear();
}

// Runs when this module is evaluated, before any resolution can fill the memo,
// so no in-process rewrite of `indexDir` is missed. The listener registry is a
// Set, so this cannot evict `src/config.ts`'s learning-cache reset.
onProjectConfigSaved(clearLocationCache);

/**
 * Memoized on realpath(startPath) and the MNEMEX_INDEX_DIR value.
 * NEVER throws. NEVER touches credentials.
 */
export function resolveStoreLocation(startPath: string): StoreLocation {
	const canonical = canonicalStartPath(startPath);
	const envValue = process.env[INDEX_DIR_ENV_VAR];
	const key = memoKey(canonical, envValue);
	const cached = locationCache.get(key);
	if (cached !== undefined) return cached;

	const location = pickStoreDir(
		gatherStoreInputs(canonical, envValue),
		STORE_SCOPE_DEFAULT,
	);
	if (locationCache.size >= STORE_LOCATION_CACHE_MAX) {
		const oldest = locationCache.keys().next().value;
		if (oldest !== undefined) locationCache.delete(oldest);
	}
	locationCache.set(key, location);
	return location;
}

/**
 * Step 1 and every read Step 2 needs, done now, unmemoized. NEVER throws.
 *
 * Exported so tests can feed {@link pickStoreDir} real inputs under either
 * scope. Production code calls {@link resolveStoreLocation}.
 */
export function readStoreInputs(startPath: string): StoreInputs {
	return gatherStoreInputs(
		canonicalStartPath(startPath),
		process.env[INDEX_DIR_ENV_VAR],
	);
}

/**
 * Step 2 of §2.3: the precedence, as a PURE function of its arguments. It reads
 * no file, no environment variable and no clock, so both scopes can be tested
 * without a setter on the production default.
 *
 * Returns the whole location, not just `storeDir`: every other field derives
 * from the same inputs, and the location is frozen because one memoized object
 * is shared by every caller of a path.
 */
export function pickStoreDir(
	inputs: StoreInputs,
	scope: StoreScope,
): StoreLocation {
	const { startPath, gitLayout, degradedReason } = inputs;
	const pathRoot = pathRootOf(startPath, gitLayout);
	const worktreeDir = join(pathRoot, PROJECT_CONFIG_DIR);

	const locate = (
		storeDir: string,
		kind: StoreKind,
		ignoredLegacyIndexDir: boolean,
	): StoreLocation =>
		Object.freeze({
			storeDir,
			worktreeDir,
			pathRoot,
			kind,
			gitLayout,
			degradedReason,
			ignoredLegacyIndexDir,
			envIndexDir: inputs.envIndexDir,
		});

	// Row 1. Empty counts as unset, as it does at `src/mcp/config.ts`.
	const envValue = inputs.envIndexDir;
	if (envValue !== undefined && envValue !== "") {
		return locate(resolveOverride(envValue, pathRoot), "env-override", false);
	}

	// Row 2.
	const configured = classifyConfiguredIndexDir(inputs.configIndexDir);
	if (configured.indexDir !== null) {
		return locate(
			resolveOverride(configured.indexDir, pathRoot),
			"config-override",
			false,
		);
	}

	// Row 3, gated by scope.
	if (gitLayout !== null) {
		if (scope === "git-common-dir") {
			return locate(
				join(gitLayout.gitCommonDir, GIT_STORE_DIR_NAME),
				"git-common-dir",
				configured.ignoredLegacy,
			);
		}
		// Row 4's formula, deliberately: Phase 2 callers pass `projectPath` as
		// `startPath`, so this is today's `getIndexDir`. From a subdirectory it is
		// `<subdir>/.mnemex`, which is also what `getIndexDir(<subdir>)` returns.
		// `pathRoot` is still the worktree root; it starts mattering in 3a.
		return locate(
			join(startPath, PROJECT_CONFIG_DIR),
			"worktree-local",
			configured.ignoredLegacy,
		);
	}

	// Row 4, FR-7: today's per-directory store. With no layout `pathRoot` IS
	// the start path, so here `storeDir === worktreeDir`, as it is today.
	return locate(
		join(startPath, PROJECT_CONFIG_DIR),
		"plain-directory",
		configured.ignoredLegacy,
	);
}

/** `<storeDir>/index.db` */
export function getIndexDbPathFor(loc: StoreLocation): string {
	return join(loc.storeDir, INDEX_DB_FILE);
}

/** `<storeDir>/vectors` */
export function getVectorStorePathFor(loc: StoreLocation): string {
	return join(loc.storeDir, VECTORS_DIR);
}

/** `<storeDir>/.indexing.lock`: the lock follows the data it guards (FR-2). */
export function getLockPathFor(loc: StoreLocation): string {
	return join(loc.storeDir, LOCK_FILE);
}

/** `<storeDir>/docs-cache` */
export function getDocsCachePathFor(loc: StoreLocation): string {
	return join(loc.storeDir, DOCS_CACHE_DIR);
}

/** `<storeDir>/store.json` */
export function getStoreMetaPathFor(loc: StoreLocation): string {
	return join(loc.storeDir, STORE_META_FILE);
}

/** `<storeDir>/branches.json` */
export function getBranchRegistryPathFor(loc: StoreLocation): string {
	return join(loc.storeDir, BRANCH_REGISTRY_FILE);
}

/**
 * The files `probeOldStore` (store-meta.ts) looks for inside a DIRECTORY it was
 * handed, not a resolved location (architecture §6.1). The store being replaced
 * may be one the seam no longer resolves to, so there is no `StoreLocation` to
 * derive it from. Built here, not by the caller, so the path rule has one copy.
 */
export function storeFilesIn(dir: string): {
	readonly indexDb: string;
	readonly storeMeta: string;
	/** The pre-v4 `config.json`, whose `indexVersion` only `probeOldStore` may read. */
	readonly legacyConfig: string;
} {
	return {
		indexDb: join(dir, INDEX_DB_FILE),
		storeMeta: join(dir, STORE_META_FILE),
		legacyConfig: join(dir, PROJECT_CONFIG_FILE),
	};
}

/** Drop every memoized location. Tests only. */
export function __resetStoreLocationCacheForTests(): void {
	clearLocationCache();
}

// ════════════════════════════════════════════════════════════════════════════

/**
 * The memo key. JSON of a two-element array is unambiguous whatever either part
 * contains, and `null` keeps "unset" distinct from the empty string. Both of
 * those resolve the same way, and a key that is exact costs nothing.
 */
function memoKey(canonical: string, envValue: string | undefined): string {
	return JSON.stringify([canonical, envValue ?? null]);
}

/**
 * `realpathSync.native`, falling back to `path.resolve` for a path that does
 * not exist. Every path in a `StoreLocation` derives from this, not from the
 * caller's spelling, because two spellings of one directory share a memo entry.
 */
function canonicalStartPath(startPath: string): string {
	try {
		return realpathSync.native(startPath);
	} catch {
		return resolve(startPath);
	}
}

/** Step 1's `pathRoot`: the worktree root, or the start path outside a repository. */
function pathRootOf(startPath: string, gitLayout: GitLayout | null): string {
	return gitLayout?.worktreeRoot ?? startPath;
}

/** Step 1, then the reads Step 2 needs. `startPath` must already be canonical. */
function gatherStoreInputs(
	startPath: string,
	envIndexDir: string | undefined,
): StoreInputs {
	const result = readGitLayout(startPath);
	const gitLayout = result.layout;
	return {
		startPath,
		gitLayout,
		degradedReason: result.layout === null ? result.degradedReason : null,
		envIndexDir,
		configIndexDir: readConfigIndexDir(pathRootOf(startPath, gitLayout)),
	};
}

/**
 * `path.isAbsolute`, never `startsWith("/")`: the latter classifies `C:\…` as
 * relative, which is the pre-existing defect in `src/config.ts` getIndexDir.
 */
function resolveOverride(value: string, pathRoot: string): string {
	return isAbsolute(value) ? value : join(pathRoot, value);
}

/**
 * `indexDir` from `mnemex.json`, then `<worktreeDir>/config.json`, both at
 * `pathRoot` (§2.3 row 2), unvalidated. `undefined` if there is no config or
 * reading it threw.
 */
function readConfigIndexDir(pathRoot: string): unknown {
	let config: unknown;
	try {
		config = loadProjectConfig(pathRoot);
	} catch {
		return undefined;
	}
	return typeof config === "object" && config !== null
		? (config as { indexDir?: unknown }).indexDir
		: undefined;
}

/**
 * Everything that is not a non-empty string is treated as unset, where today's
 * `getIndexDir` would throw on a number. The literal legacy default is reported
 * as ignored (D2).
 */
function classifyConfiguredIndexDir(value: unknown): {
	indexDir: string | null;
	ignoredLegacy: boolean;
} {
	if (typeof value !== "string" || value === "") {
		return { indexDir: null, ignoredLegacy: false };
	}
	if (value === LEGACY_DEFAULT_INDEX_DIR) {
		return { indexDir: null, ignoredLegacy: true };
	}
	return { indexDir: value, ignoredLegacy: false };
}
