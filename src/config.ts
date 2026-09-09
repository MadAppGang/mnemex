/**
 * Configuration management for mnemex
 *
 * Handles both global config (~/.mnemex/config.json) and
 * project-specific config (.mnemex/config.json)
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	hydrateSecrets,
	invalidateSecretSessionCache,
	persistSecrets,
	resolveSecret,
	type SecretPersistReport,
	setKeychainConfigOptOut,
	setKeychainOptOutProvider,
} from "./core/secrets.js";
import type {
	EmbeddingProvider,
	GlobalConfig,
	ProjectConfig,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Global config directory */
export const GLOBAL_CONFIG_DIR = join(homedir(), ".mnemex");

/** Global config file path */
export const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");

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

/** Embedding models cache file */
export const MODELS_CACHE_FILE = "embedding-models.json";

/** Cache max age in days */
export const CACHE_MAX_AGE_DAYS = 2;

/** Default exclude patterns - comprehensive list of non-source directories
 * Note: Patterns use ** prefix to match at any depth in the tree
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
	// ─── Package managers & dependencies ───
	"**/node_modules/**",
	"**/bower_components/**",
	"**/jspm_packages/**",
	"**/.pnpm/**",
	"**/vendor/**", // Go, PHP, Ruby
	"**/Pods/**", // iOS CocoaPods
	"**/Carthage/**", // iOS Carthage
	"**/.bundle/**", // Ruby bundler

	// ─── Build outputs ───
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/output/**",
	"**/target/**", // Rust, Java/Maven
	"**/bin/**",
	"**/obj/**", // .NET
	"**/_build/**", // Elixir
	"**/.output/**",
	"**/artifacts/**",

	// ─── Framework-specific ───
	"**/.next/**",
	"**/.nuxt/**",
	"**/.svelte-kit/**",
	"**/.vercel/**",
	"**/.netlify/**",
	"**/.serverless/**",
	"**/.turbo/**",
	"**/.cache/**",
	"**/.parcel-cache/**",
	"**/.webpack/**",
	"**/.rollup.cache/**",
	"**/.vite/**",
	"**/.angular/**",
	"**/.expo/**",

	// ─── Version control ───
	"**/.git/**",
	"**/.svn/**",
	"**/.hg/**",
	"**/.fossil/**",

	// ─── IDE & editors ───
	"**/.idea/**",
	"**/.vscode/**",
	"**/*.swp",
	"**/*.swo",
	"**/*~",
	"**/.project",
	"**/.classpath",
	"**/.settings/**",
	"**/*.xcworkspace/**",
	"**/*.xcodeproj/**",

	// ─── Testing & coverage ───
	"**/coverage/**",
	"**/.nyc_output/**",
	"**/htmlcov/**",
	"**/.pytest_cache/**",
	"**/.tox/**",
	"**/.nox/**",
	"**/__tests__/**/__snapshots__/**",

	// ─── Python ───
	"**/__pycache__/**",
	"**/*.pyc",
	"**/*.pyo",
	"**/*.pyd",
	"**/.Python",
	"**/venv/**",
	"**/.venv/**",
	"**/virtualenv/**",
	"**/.eggs/**",
	"**/*.egg-info/**",
	"**/.mypy_cache/**",
	"**/.ruff_cache/**",

	// ─── Generated & compiled ───
	"**/*.min.js",
	"**/*.min.css",
	"**/*.map",
	"**/*.d.ts", // TypeScript declarations (often generated)
	"**/*.generated.*",
	"**/generated/**",
	"**/auto-generated/**",

	// ─── Lock files ───
	"**/*.lock",
	"**/package-lock.json",
	"**/yarn.lock",
	"**/pnpm-lock.yaml",
	"**/bun.lockb",
	"**/Gemfile.lock",
	"**/poetry.lock",
	"**/Pipfile.lock",
	"**/composer.lock",
	"**/Cargo.lock",
	"**/go.sum",
	"**/mix.lock",
	"**/pubspec.lock",

	// ─── Logs & temp files ───
	"**/*.log",
	"**/logs/**",
	"**/tmp/**",
	"**/temp/**",
	"**/.tmp/**",
	"**/.temp/**",

	// ─── Data & databases ───
	"**/*.sqlite",
	"**/*.sqlite3",
	"**/*.db",

	// ─── Documentation builds ───
	"**/docs/_build/**",
	"**/_site/**", // Jekyll output

	// ─── Misc ───
	"**/.mnemex/**",
	"**/.DS_Store",
	"**/Thumbs.db",
	"**/.terraform/**",
	"**/.vagrant/**",
	"**/.docker/**",
];

/** Default recommended embedding model */
export const DEFAULT_EMBEDDING_MODEL = "voyage-3.5-lite";

/** OpenRouter API endpoints */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_EMBEDDINGS_URL = `${OPENROUTER_API_URL}/embeddings`;
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_URL}/models`;
export const OPENROUTER_EMBEDDING_MODELS_URL = `${OPENROUTER_API_URL}/embeddings/models`;

/** OpenRouter request headers */
export const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/MadAppGang/mnemex",
	"X-Title": "mnemex",
};

/** Voyage AI API endpoint */
export const VOYAGE_API_URL = "https://api.voyageai.com/v1";
export const VOYAGE_EMBEDDINGS_URL = `${VOYAGE_API_URL}/embeddings`;

// ============================================================================
// Environment Variables
// ============================================================================

export const ENV = {
	OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
	VOYAGE_API_KEY: "VOYAGE_API_KEY",
	MNEMEX_MODEL: "MNEMEX_MODEL",
	ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
	/** Unified LLM spec (e.g., "a/sonnet", "or/openai/gpt-4o", "cc/sonnet") */
	MNEMEX_LLM: "MNEMEX_LLM",
	/** Context7 API key for documentation fetching */
	CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
	/** Enable/disable documentation fetching (default: true) */
	MNEMEX_DOCS_ENABLED: "MNEMEX_DOCS_ENABLED",
	/** Ollama API key — GENERATION only, never the embeddings path (CLAUDE.md #18) */
	OLLAMA_API_KEY: "OLLAMA_API_KEY",
	/** What to do when the index's model differs from the configured one */
	MNEMEX_ON_MODEL_MISMATCH: "MNEMEX_ON_MODEL_MISMATCH",
	/** Colour theme override: "light" | "dark" (read pre-dotenv, see src/ui/theme-env.ts) */
	MNEMEX_THEME: "MNEMEX_THEME",
	// NOT REGISTERED HERE, deliberately: `MNEMEX_DISABLE_EMBED_CACHE` and
	// `MNEMEX_EMBED_CACHE_PATH`. `src/core/embed-cache.ts` owns and reads both
	// (`ENV_DISABLE` / `ENV_PATH` there), because that module may not import
	// this one — it is a leaf on purpose, so the embedding cache cannot pull
	// config, keychain or the LLM stack into its graph, and a unit test pins its
	// import list. Registering the names here would need exactly that import.
	//
	// The cost is discoverability, which this comment pays: grep for either name
	// and land in `embed-cache.ts`. The related config field IS here —
	// `GlobalConfig.embedCache` — and reaches the cache as a parameter from
	// `Indexer.index()`, which imports both sides.
} as const;

/** Context7 API endpoint */
export const CONTEXT7_API_URL = "https://context7.com/api/v2";

/** DevDocs API endpoint */
export const DEVDOCS_API_URL = "https://devdocs.io";

/** Default documentation cache TTL in hours */
export const DEFAULT_DOCS_CACHE_TTL = 24;

/** Default max pages per library */
export const DEFAULT_DOCS_MAX_PAGES = 10;

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Read ~/.mnemex/config.json exactly as it is on disk. No defaults, no merging,
 * no keychain. `corrupt` is true when the file EXISTS and does not parse — the
 * difference between "nothing there" and "I could not read it", which is the same
 * distinction the keychain engine makes and for the same reason.
 */
function readGlobalConfigFileRaw(): {
	parsed: Record<string, unknown> | null;
	corrupt: boolean;
} {
	if (!existsSync(GLOBAL_CONFIG_PATH)) return { parsed: null, corrupt: false };
	try {
		const parsed = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return { parsed: null, corrupt: true };
		}
		return { parsed: parsed as Record<string, unknown>, corrupt: false };
	} catch {
		return { parsed: null, corrupt: true };
	}
}

// The persistent `"keychain": false` opt-out, registered so the enable gate is
// correct on the FIRST getter call in a process, before anything has loaded the
// config. It is invoked lazily and at most once, and reads the raw file rather
// than going through `loadGlobalConfig` so it can never recurse into the getters
// it gates.
setKeychainOptOutProvider(
	() => readGlobalConfigFileRaw().parsed?.keychain === false,
);

/**
 * Load global configuration from ~/.mnemex/config.json.
 *
 * PERFORMS ZERO KEYCHAIN ACCESS, at all 16 call sites. It used to pay
 * `mergeKeychainSecrets` — five lookups on the MISS path at 22.4 ms each, about
 * 112 ms of spawn cost for a config load that needs none of it — on the indexing
 * path among others.
 *
 * Two independent legs make dropping the merge safe:
 *
 *  1. REDUNDANCY. Every secret consumer goes through a getter, and each getter
 *     consults the keychain itself at step 2. Exactly one consumer outside this
 *     file and the wizard's own state reads a secret field off a
 *     `loadGlobalConfig()` result, and it switches to
 *     `loadGlobalConfigWithSecrets()`.
 *  2. CORRECTNESS. `saveGlobalConfig` merges over `existing`. If `existing`
 *     carried keychain-sourced values, a keychain-sourced secret could be flushed
 *     into plaintext by a later failure — a leak created by the fix. Removing the
 *     merge is a PRECONDITION for that being safe; it is not on its own
 *     sufficient, which is why `saveGlobalConfig` re-reads the raw file.
 *
 * Rejected: lazy `Object.defineProperty` getters on the returned config. Elegant
 * and broken on contact — a spread MATERIALISES every getter, as do
 * `JSON.stringify` and structured cloning, in places with nothing to do with secrets.
 */
export function loadGlobalConfig(): GlobalConfig {
	const defaultConfig: GlobalConfig = {
		excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
	};

	const { parsed } = readGlobalConfigFileRaw();
	if (!parsed) {
		// LOW (b): the opt-out cache must follow the file in BOTH directions. A
		// `keychain: false` read earlier in this process otherwise survived the file
		// being deleted or moved aside — which `preserveCorruptGlobalConfig` does —
		// leaving the backend silently disabled for the rest of the run.
		setKeychainConfigOptOut(false);
		return defaultConfig;
	}

	const loaded = parsed as Partial<GlobalConfig>;
	// Keep the enable gate in step with the file without letting secrets.ts import
	// this module (M9; the dependency stays one-way, config -> secrets).
	setKeychainConfigOptOut(loaded.keychain === false);

	return {
		...defaultConfig,
		...loaded,
		excludePatterns: [
			...DEFAULT_EXCLUDE_PATTERNS,
			...(loaded.excludePatterns || []),
		],
	};
}

/**
 * `loadGlobalConfig()` plus keychain-stored secrets overlaid ON TOP of the file's
 * values (keychain wins, matching F3 and `resolveSecret`).
 *
 * Explicit and opt-in: exactly one caller wants it, the setup wizard's prefill.
 * Costs one `dump-keychain` plus one read per stored id.
 */
export function loadGlobalConfigWithSecrets(): GlobalConfig {
	return hydrateSecrets(loadGlobalConfig());
}

/** O(1) membership for the write-side normalisation below. */
const DEFAULT_EXCLUDE_SET = new Set(DEFAULT_EXCLUDE_PATTERNS);

/**
 * What `excludePatterns` should look like IN THE FILE: the user's own additions,
 * de-duplicated, in order, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * C2 — the file grew by 102 entries on every save.
 *
 * `loadGlobalConfig` PREPENDS all 102 `DEFAULT_EXCLUDE_PATTERNS` for the caller's
 * convenience, so every consumer sees a complete list without having to know the
 * defaults exist. Callers then hand that same object back to `saveGlobalConfig`,
 * which wrote the concatenation to disk, and the next load prepended the defaults
 * again. Measured on a real `~/.mnemex/config.json`: 408 entries, 102 unique, 306
 * duplicates — four accumulated rounds.
 *
 * The distinction that fixes it is between the list as SERVED and the list as
 * STORED. Only the additions are stored. Behaviour is unchanged in both
 * directions: `loadGlobalConfig` puts the defaults back on the way out, and
 * `getExcludePatterns` seeds its Set with `DEFAULT_EXCLUDE_PATTERNS`
 * independently, so removing them from the file can exclude nothing new and
 * un-exclude nothing old. A user pattern that happens to equal a default is
 * dropped from the file and still applied, for the same reason.
 *
 * Applied to the MERGED object rather than to the incoming one, so an
 * already-polluted file is healed by the next save whatever that save was about.
 */
function normaliseExcludePatterns(patterns: readonly unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		// The field is typed `string[]`; anything else is junk a hand-edit left
		// behind, matches no file, and is not worth carrying forward.
		if (typeof pattern !== "string") continue;
		if (DEFAULT_EXCLUDE_SET.has(pattern)) continue;
		if (seen.has(pattern)) continue;
		seen.add(pattern);
		out.push(pattern);
	}
	return out;
}

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

/**
 * Parse .gitignore file and return glob patterns
 */
export function parseGitignore(projectPath: string): string[] {
	const gitignorePath = join(projectPath, ".gitignore");

	if (!existsSync(gitignorePath)) {
		return [];
	}

	try {
		const content = readFileSync(gitignorePath, "utf-8");
		const patterns: string[] = [];

		for (const line of content.split("\n")) {
			const trimmed = line.trim();

			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}

			// Skip negation patterns (we don't support them yet)
			if (trimmed.startsWith("!")) {
				continue;
			}

			// Convert gitignore pattern to glob pattern
			let pattern = trimmed;

			// If pattern ends with /, it's a directory - add **
			if (pattern.endsWith("/")) {
				pattern = `${pattern}**`;
			}
			// If pattern doesn't contain /, it matches anywhere
			else if (!pattern.includes("/")) {
				// Could be a file or directory name
				patterns.push(pattern);
				patterns.push(`**/${pattern}`);
				patterns.push(`${pattern}/**`);
				patterns.push(`**/${pattern}/**`);
				continue;
			}
			// If pattern starts with /, it's relative to root
			else if (pattern.startsWith("/")) {
				pattern = pattern.slice(1);
			}

			patterns.push(pattern);
			// Also add with ** suffix if it looks like a directory
			if (!pattern.includes(".") && !pattern.endsWith("**")) {
				patterns.push(`${pattern}/**`);
			}
		}

		return patterns;
	} catch (error) {
		console.warn("Failed to parse .gitignore:", error);
		return [];
	}
}

/**
 * Get all exclude patterns for a project
 * Combines: defaults + global config + project config + gitignore (if enabled)
 *
 * @param projectPath - Root directory of the project
 * @param useGitignore - Override whether to include gitignore patterns.
 *   If undefined, falls back to the project config value (default: true).
 */
export function getExcludePatterns(
	projectPath: string,
	useGitignore?: boolean,
): string[] {
	const patterns = new Set<string>(DEFAULT_EXCLUDE_PATTERNS);

	// Add global config patterns
	const globalConfig = loadGlobalConfig();
	for (const p of globalConfig.excludePatterns) {
		patterns.add(p);
	}

	// Load project config
	const projectConfig = loadProjectConfig(projectPath);

	// Add project-specific patterns
	if (projectConfig?.excludePatterns) {
		for (const p of projectConfig.excludePatterns) {
			patterns.add(p);
		}
	}

	// Determine whether to include gitignore patterns:
	// caller override → project config → default (true)
	const shouldUseGitignore =
		useGitignore !== undefined
			? useGitignore
			: projectConfig?.useGitignore !== false;
	if (shouldUseGitignore) {
		const gitignorePatterns = parseGitignore(projectPath);
		for (const p of gitignorePatterns) {
			patterns.add(p);
		}
	}

	return Array.from(patterns);
}

// ============================================================================
// ~/.mnemex/config.json is a SECRET STORE — permissions, atomicity, serialisation
// ============================================================================
//
// After the keychain rewrite a secret can legitimately remain in this file, and
// every user upgrading from <= 0.32.0 already has ALL of their API keys here in
// plaintext at mode 0644 (the keychain module never shipped). The file therefore
// gets the treatment `src/cloud/auth.ts` already gives `credentials.json`.

/**
 * THE credential mutation lock. ~2 s acquisition budget, 10 s staleness.
 *
 * NOT "advisory and best-effort" any more, and the change of wording is the fix.
 * `acquireConfigLock()` returned `null` after the budget and `saveGlobalConfig()`
 * carried on with its read-modify-write regardless — it FAILED OPEN. External
 * review supplied the sequence: two supported saves overlap, the loser's stale
 * merged snapshot wins the rename, and a credential whose keychain write failed
 * exists in neither place. A lock that proceeds when it cannot be taken is not a
 * lock; every acquisition failure is now a refusal (`ConfigLockUnavailableError`).
 *
 * It covers ONE resource pair — `~/.mnemex/config.json` and the mnemex keychain
 * items — because those two are the ends of the cross-resource TOCTOU that lets
 * `keychain prune` and `keychain rm` between them delete both copies of a
 * credential: prune verifies the keychain, rm sees the still-present plaintext,
 * rm deletes the item, prune deletes the line. Every command that touches either
 * end (`save`, `migrate`, `prune`, `rm`) now runs inside `withConfigLock`, so
 * that interleaving cannot be constructed.
 */
const CONFIG_LOCK_PATH = join(GLOBAL_CONFIG_DIR, "config.lock");
const CONFIG_LOCK_BUDGET_MS = 2000;
const CONFIG_LOCK_STALE_MS = 10000;
const CONFIG_LOCK_POLL_MS = 25;

/**
 * Thrown instead of proceeding unlocked. A distinct type so a caller can render
 * "another mnemex is changing your credentials, nothing was touched" rather than
 * a generic failure, and so `catch (e) {}` somewhere cannot quietly restore the
 * fail-open behaviour by looking like an ordinary I/O error.
 */
export class ConfigLockUnavailableError extends Error {
	constructor(reason: string) {
		super(
			`could not take the ~/.mnemex credential lock (${reason}); nothing was changed. ` +
				"Another mnemex process may be saving, migrating or pruning credentials.",
		);
		this.name = "ConfigLockUnavailableError";
	}
}

/**
 * A bounded synchronous sleep, so the lock wait is a short retry loop rather than
 * a busy spin. No `saveGlobalConfig` call site sits inside the index lock's
 * critical region, so this 2 s ceiling is outside `lock.ts`'s heartbeat window by
 * construction — verified across all four call sites.
 */
function sleepSyncMs(ms: number): void {
	if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	const shared = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(shared, 0, 0, ms);
}

/**
 * The token written INTO the lock file, and checked again before we unlink it.
 *
 * Without it, release is "unlink whatever is at that path", so an owner whose
 * lock had already been reclaimed as stale would delete the NEW owner's lock and
 * put two writers on the file at once. pid alone is not enough — pids are reused.
 */
function newLockToken(): string {
	return `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The three instants inside a stale takeover at which another process could
 * change the world underneath this one. Each one is a layer of the defence, and
 * each is separately stageable — see `test/unit/config/credential-lock-reclaim`.
 *
 *  - `judged`   — the mtime says the holder is dead. The exclusive right to
 *                 reclaim THIS lock has just been won; nothing has been acted on.
 *  - `verified` — the lock still carries the token and mtime that were judged.
 *  - `detached` — the lock file has been moved aside and is about to be compared.
 */
export type ConfigLockStalePhase = "judged" | "verified" | "detached";

/**
 * A hook fired at those two instants. `null` in production; nothing else reads it.
 *
 * It exists because the defect it guards against lives ENTIRELY in the gap
 * between a judgement and the act on it, and a race reproducible only by chance
 * is a race whose fix cannot be shown to work. With this, the two-owner
 * interleaving is staged deterministically: the hook does what the other process
 * would have done — reclaim the stale lock and install one of its own — and the
 * assertion is that this process then refuses instead of deleting it.
 *
 * It cannot weaken the lock. It takes no decision, its return value is ignored,
 * and every step after it is re-derived from the filesystem.
 */
let onConfigLockStalePhase: ((phase: ConfigLockStalePhase) => void) | null =
	null;

/** Test-only. See `onConfigLockStalePhase`. */
export function setConfigLockStaleHook(
	hook: ((phase: ConfigLockStalePhase) => void) | null,
): void {
	onConfigLockStalePhase = hook;
}

/**
 * ATOMICALLY take the lock file out of the way, and report WHAT WAS TAKEN.
 *
 * This is the whole answer to "compare the owner token under an atomic
 * operation, not check-then-act". `rename` moves a specific inode out of the
 * well-known name in one step: after it returns, no other process can act on the
 * thing we removed, and only then do we read its token and decide whether we were
 * entitled to remove it. Swap first, compare second, roll back on mismatch.
 *
 * The previous code did the opposite — `statSync` said stale, and a later
 * `unlinkSync(path)` deleted whatever happened to be at that name by then. Two
 * processes that both observed one stale lock could therefore both delete: the
 * first reclaimed it and installed its own, the second deleted THAT, and both
 * entered their critical sections. That is two owners, and two owners is the
 * `prune`/`rm` credential-destruction sequence back in full.
 *
 * Returns `null` when the name was already empty — someone else got there first,
 * which is a retry, not an error.
 */
function detachLockFile(): { path: string; token: string } | null {
	const path = `${CONFIG_LOCK_PATH}.detached-${newLockToken()}`;
	try {
		renameSync(CONFIG_LOCK_PATH, path);
	} catch {
		return null;
	}
	let token = "";
	try {
		token = readFileSync(path, "utf8");
	} catch {
		// An unreadable detached lock is not proof of anything; the empty string
		// only matches a lock that was itself never stamped.
	}
	return { path, token };
}

/**
 * Put back a lock we detached but were not entitled to remove.
 *
 * `link` rather than `rename`: it FAILS if the name is occupied instead of
 * overwriting, so restoring can never clobber a third process's lock. If it does
 * fail we are in a state we cannot describe truthfully, so the caller refuses.
 */
function restoreDetachedLock(detached: { path: string }): boolean {
	try {
		linkSync(detached.path, CONFIG_LOCK_PATH);
	} catch {
		return false;
	}
	try {
		unlinkSync(detached.path);
	} catch {}
	return true;
}

/** Outcome of trying to take over a lock whose mtime says its holder died. */
type Reclaim = "reclaimed" | "retry" | "ambiguous";

/** FNV-1a, for a short path-safe name derived from an arbitrary lock token. */
function shortHash(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * The name of the EXCLUSIVE RIGHT to reclaim the lock identified by this exact
 * (token, mtime) pair.
 *
 * Deterministic across processes on purpose: every process that judges the same
 * stale lock computes the same name, so `openSync(..., "wx")` — which is atomic —
 * elects exactly one of them.
 */
function reclaimClaimPath(token: string, mtimeMs: number): string {
	return `${CONFIG_LOCK_PATH}.reclaim-${shortHash(token)}-${Math.trunc(mtimeMs)}`;
}

/** Read the lock's identity: what it says, and how old it is. */
function observeLockFile(): { token: string; mtimeMs: number } | null {
	try {
		return {
			token: readFileSync(CONFIG_LOCK_PATH, "utf8"),
			mtimeMs: statSync(CONFIG_LOCK_PATH).mtimeMs,
		};
	} catch {
		return null;
	}
}

/**
 * Take over a lock last stamped with `observed`, or do nothing.
 *
 * THREE LAYERS, because a lock file protocol has no primitive that both removes
 * and identifies in one step, and each layer closes what the one below it cannot:
 *
 *  1. ELECTION. Only the process that wins `openSync(claim, "wx")` may touch the
 *     lock at all. Without this, every contender that judged one stale lock is
 *     entitled to remove whatever is at that name later — the reported defect —
 *     and, worse, each of them briefly makes the name FREE while checking, which
 *     hands a live owner's lock to whoever polls next. Measured: an eight-process
 *     race over one stale lock produced an overlap without this layer.
 *  2. RE-VERIFICATION. The winner re-derives (token, mtime) while holding the
 *     right, so a takeover that completed since the judgement is seen.
 *  3. DETACH AND COMPARE. `rename` moves a specific inode out of the well-known
 *     name in one atomic step; only then is its token compared. Whatever we
 *     removed, we removed exclusively, and we can say what it was. If it was not
 *     ours to remove we put it back, and if we cannot put it back we refuse.
 *
 * A process that dies holding the claim leaves a file named after a lock that is
 * itself stale; the next pass drops it once it is older than the staleness window
 * and tries again, so a crash costs one window rather than wedging the CLI.
 */
function reclaimStaleLock(observed: {
	token: string;
	mtimeMs: number;
}): Reclaim {
	const claim = reclaimClaimPath(observed.token, observed.mtimeMs);
	let claimFd: number;
	try {
		claimFd = openSync(claim, "wx");
	} catch {
		// Another process is reclaiming this exact lock — or died doing so.
		try {
			if (Date.now() - statSync(claim).mtimeMs > CONFIG_LOCK_STALE_MS) {
				unlinkSync(claim);
			}
		} catch {}
		return "retry";
	}

	try {
		try {
			writeFileSync(claimFd, `${process.pid}`, "utf8");
		} catch {}
		try {
			closeSync(claimFd);
		} catch {}

		onConfigLockStalePhase?.("judged");

		// LAYER 2 — is the thing we judged still the thing that is there?
		const current = observeLockFile();
		if (
			current === null ||
			current.token !== observed.token ||
			Math.trunc(current.mtimeMs) !== Math.trunc(observed.mtimeMs)
		) {
			return "retry";
		}

		onConfigLockStalePhase?.("verified");

		// LAYER 3 — swap first, compare second.
		const detached = detachLockFile();
		if (detached === null) return "retry";

		onConfigLockStalePhase?.("detached");

		if (detached.token === observed.token) {
			try {
				unlinkSync(detached.path);
			} catch {}
			return "reclaimed";
		}

		// NOT the lock we judged. Someone else owns this one.
		return restoreDetachedLock(detached) ? "retry" : "ambiguous";
	} finally {
		try {
			unlinkSync(claim);
		} catch {}
	}
}

function acquireConfigLock(): { fd: number; token: string } | null {
	const deadline = Date.now() + CONFIG_LOCK_BUDGET_MS;
	for (;;) {
		try {
			const fd = openSync(CONFIG_LOCK_PATH, "wx");
			const token = newLockToken();
			try {
				writeFileSync(fd, token, "utf8");
			} catch {
				// A lock we cannot stamp is a lock we must not claim: release would
				// then be unable to prove ownership and would unlink blindly.
				try {
					closeSync(fd);
				} catch {}
				try {
					unlinkSync(CONFIG_LOCK_PATH);
				} catch {}
				return null;
			}
			return { fd, token };
		} catch {
			// Read the identity AND the age of the thing we are about to judge. The
			// token is what makes the takeover verifiable; the mtime only decides
			// whether to attempt one, and both together name the takeover claim.
			// `null` means the holder released it between our open and our read.
			const observed = observeLockFile();

			if (
				observed !== null &&
				Date.now() - observed.mtimeMs > CONFIG_LOCK_STALE_MS
			) {
				const outcome = reclaimStaleLock(observed);
				// AMBIGUOUS means we detached a live lock and could not put it back,
				// so we cannot say who holds what. Refusing is the only honest move;
				// proceeding here is exactly the two-owner state being prevented.
				if (outcome === "ambiguous") return null;
				if (outcome === "reclaimed") continue;
			}

			if (Date.now() >= deadline) return null;
			sleepSyncMs(CONFIG_LOCK_POLL_MS);
		}
	}
}

function releaseConfigLock(lock: { fd: number; token: string } | null): void {
	if (lock === null) return;
	try {
		closeSync(lock.fd);
	} catch {}

	// Same atomic swap-then-compare as the takeover, for the same reason: reading
	// the token and then unlinking the PATH is check-then-act, and if our lock had
	// already been reclaimed as stale we would delete the new owner's lock in the
	// window between the two calls. Detaching first means whatever we compare is
	// something no one else can still be using.
	const detached = detachLockFile();
	if (detached === null) return;
	if (detached.token === lock.token) {
		try {
			unlinkSync(detached.path);
		} catch {}
		return;
	}
	// Not ours any more. Put it back; if we cannot, leave the file for
	// `sweepStaleConfigDebris` rather than destroying someone's evidence.
	restoreDetachedLock(detached);
}

/** Depth, so the four commands can nest the shared lock without deadlocking. */
let configLockDepth = 0;
let heldConfigLock: { fd: number; token: string } | null = null;

/**
 * Run `fn` holding the credential lock, or DO NOT RUN IT AT ALL.
 *
 * Re-entrant within a process on purpose: `keychain prune` must hold the lock
 * across the raw file read, the keychain verification AND the file replacement,
 * and the replacement is `removeGlobalConfigFields`, which takes the same lock.
 * A non-re-entrant lock would deadlock for two seconds and then — under the old
 * fail-open rule — proceed anyway, which is how the hole stayed open.
 *
 * Re-entrancy is per-process state and is therefore NOT a weakening: the race
 * being closed is between processes, and the file lock is what serialises those.
 */
export function withConfigLock<T>(fn: () => T): T {
	if (configLockDepth > 0) {
		configLockDepth++;
		try {
			return fn();
		} finally {
			configLockDepth--;
		}
	}

	ensureGlobalConfigDir();
	const lock = acquireConfigLock();
	if (!lock) {
		// FAIL CLOSED. This is the whole point of the change.
		throw new ConfigLockUnavailableError(
			`no lock after ${CONFIG_LOCK_BUDGET_MS} ms at ${CONFIG_LOCK_PATH}`,
		);
	}
	heldConfigLock = lock;
	configLockDepth = 1;
	try {
		return fn();
	} finally {
		configLockDepth = 0;
		heldConfigLock = null;
		releaseConfigLock(lock);
	}
}

/** True while this process holds the lock. Used only by assertions and tests. */
export function isConfigLockHeld(): boolean {
	return configLockDepth > 0 && heldConfigLock !== null;
}

function ensureGlobalConfigDir(): void {
	try {
		mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true, mode: 0o700 });
	} catch {
		// Best-effort: a pre-existing directory keeps its mode, which is fine.
	}
}

/**
 * Remove `config.json.tmp.*` left by a process that died between the write and
 * the rename (LOW (e)), and `config.lock.detached-*` left by one that died
 * mid-takeover.
 *
 * Not a disclosure — the tmp is created `0600` and re-`chmod`ed, and `~/.mnemex`
 * is deliberately not re-`chmod`ed when it already exists — but it holds every
 * plaintext secret the save was about to install and nothing ever removed it. One
 * `readdir` per save. The live tmp for THIS pid is excluded: the caller is about
 * to create it, and unlinking a name we are about to write is pointless churn.
 *
 * The detached-lock debris is empty of secrets (it holds an owner token) but is
 * swept for the same reason: a name nothing ever deletes accumulates forever, and
 * this runs while the credential lock is held, so nothing can be mid-takeover.
 */
function sweepStaleConfigTmpFiles(): void {
	const live = `config.json.tmp.${process.pid}`;
	try {
		for (const name of readdirSync(GLOBAL_CONFIG_DIR)) {
			const debris =
				(name.startsWith("config.json.tmp.") && name !== live) ||
				name.startsWith("config.lock.detached-") ||
				name.startsWith("config.lock.reclaim-");
			if (!debris) continue;
			const path = join(GLOBAL_CONFIG_DIR, name);
			try {
				// AGE, not pid. "A different pid is in the filename" is not evidence of
				// staleness — on Unix, unlinking a live writer's open temporary file
				// succeeds silently, so the old test could destroy another process's
				// in-flight save while reporting nothing. Only a tmp older than the
				// lock staleness window can have been abandoned.
				if (Date.now() - statSync(path).mtimeMs <= CONFIG_LOCK_STALE_MS) {
					continue;
				}
				unlinkSync(path);
			} catch {
				// Another process may own it and be mid-rename. Leave it.
			}
		}
	} catch {
		// No directory yet, or unreadable. Nothing to sweep.
	}
}

/**
 * Atomic, 0600 write.
 *
 * MEASURED, and the reason `mode:` alone is not the control it looks like:
 * `writeFileSync(p, data, {mode: 0o600})` on an EXISTING file leaves it at 644 —
 * the mode applies only when `O_CREAT` actually creates the file, and the real
 * `~/.mnemex/config.json` is `-rw-r--r--`. The population this control protects is
 * exactly the population `mode:` cannot reach. Only `chmodSync` gets to 600.
 *
 * tmp -> chmod -> rename is what makes a crash, a full disk or two concurrent
 * saves survivable: `writeFileSync` truncates in place, and a truncated file makes
 * `loadGlobalConfig` return defaults, after which the next save would write
 * defaults over it and permanently discard every setting AND every plaintext secret.
 */
function writeGlobalConfigFileAtomic(obj: Record<string, unknown>): void {
	ensureGlobalConfigDir();
	sweepStaleConfigTmpFiles();
	const tmp = `${GLOBAL_CONFIG_PATH}.tmp.${process.pid}`;
	try {
		writeFileSync(tmp, JSON.stringify(obj, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			chmodSync(tmp, 0o600);
		} catch {}
		renameSync(tmp, GLOBAL_CONFIG_PATH);
	} catch (error) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {}
		throw error;
	}
	// Belt and braces: `renameSync` carries the tmp inode's 0600, but F9's test is
	// "holds, or has ever held, a secret", and this must hold on EVERY save.
	try {
		chmodSync(GLOBAL_CONFIG_PATH, 0o600);
	} catch {
		// Non-fatal: a failed chmod must not cost the user a save.
	}
}

/** Never merge over a file we could not understand — preserve it and say so. */
function preserveCorruptGlobalConfig(): string | undefined {
	const preserved = `${GLOBAL_CONFIG_PATH}.corrupt-${Date.now()}`;
	try {
		renameSync(GLOBAL_CONFIG_PATH, preserved);
		return preserved;
	} catch {
		return undefined;
	}
}

/**
 * Save global configuration.
 *
 * Returns a `SecretPersistReport` (was `void` — additive; every current caller
 * ignores it). `src/cli.ts` consumes it so the confirmation message can say where
 * the key is NOT, which is the only notice a user gets that a downgrade will not
 * find it.
 *
 * THE TWO MERGES ARE DIFFERENT OBJECTS, and that is the whole of the fix:
 * `incoming` is what is offered to the keychain, `merged` is what goes to the
 * file. Before this change they were the same object, so a save of
 * `{llmEndpoint}` re-offered six file-resident secrets to the keychain with `-U`
 * and could overwrite a value the user had just edited in Keychain Access.app.
 */
export function saveGlobalConfig(
	config: Partial<GlobalConfig>,
): SecretPersistReport {
	ensureGlobalConfigDir();
	return withConfigLock(() => {
		// If the file exists and does not parse, preserve it BEFORE anything else.
		let corruptFilePreservedAs: string | undefined;
		if (readGlobalConfigFileRaw().corrupt) {
			corruptFilePreservedAs = preserveCorruptGlobalConfig();
		}

		const { jsonSafe, report } = persistSecrets(config);
		if (corruptFilePreservedAs) {
			report.corruptFilePreservedAs = corruptFilePreservedAs;
		}

		// Re-read INSIDE the critical section, immediately before the write, so the
		// window in which another process's save can be resurrected is as small as
		// it can be made without a real lock.
		const existing = readGlobalConfigFileRaw().parsed ?? {};
		const merged: Record<string, unknown> = { ...existing, ...jsonSafe };

		// ------------------------------------------------------------------
		// I1, second half. AN OBJECT SPREAD CANNOT DELETE A FIELD.
		//
		// Omitting a proven-stored secret from `jsonSafe` does NOT remove it from
		// `merged` — the spread takes it straight back out of `existing`. The old
		// `stripSecrets(merged)` performed that deletion; deleting `stripSecrets`
		// without replacing this step would write the secret back to config.json in
		// plaintext immediately after a successful keychain write, while the CLI
		// printed "It is NOT in ~/.mnemex/config.json".
		//
		// Only `keychain` and `cleared` are deleted: those are the two dispositions
		// this save PROVED. A failed write must leave the INCOMING value in the file
		// — deleting on failure is the original key-loss defect all over again.
		// ------------------------------------------------------------------
		for (const outcome of report.outcomes) {
			if (outcome.stored === "keychain" || outcome.stored === "cleared") {
				delete merged[outcome.field];
			}
		}

		// C2. Store the user's additions only; `loadGlobalConfig` puts the 102
		// defaults back on the way out. Without this the file grew by 102 entries
		// per save. See `normaliseExcludePatterns`.
		if (Array.isArray(merged.excludePatterns)) {
			merged.excludePatterns = normaliseExcludePatterns(merged.excludePatterns);
		}

		writeGlobalConfigFileAtomic(merged);
		setKeychainConfigOptOut(merged.keychain === false);
		invalidateSecretSessionCache();
		// The learning decision is cached per path; a rewrite must be visible.
		// Carried across the 0.35.0 merge: upstream added this to the old
		// `saveGlobalConfig` body, which this function replaced wholesale.
		resetLearningEnabledCache();
		return report;
	});
}

/**
 * Remove named top-level fields from the config file in ONE atomic write.
 *
 * `mnemex keychain prune`'s writer. A single write is what makes a mixed prune
 * safe: the verified subset is removed together, and a crash mid-verification
 * changes nothing at all.
 */
export function removeGlobalConfigFields(
	fields: string[],
	/**
	 * The value each field is EXPECTED to still hold, as verified by the caller.
	 *
	 * `pruneFileSecrets` reads the file, proves each value byte-identical against
	 * the keychain, and returns the field list; this function then re-reads the
	 * file under the config lock. Between those two reads another save can change
	 * the field — most plausibly a save whose keychain write FAILED, which writes a
	 * new plaintext value precisely because it could not be stored. Deleting
	 * unconditionally would then remove a value nobody ever verified while the
	 * keychain still held the old one. Passing the verified values makes the
	 * deletion conditional on the file not having moved underneath it.
	 *
	 * Omitted (the non-prune callers) means unconditional, as before.
	 */
	expectedValues?: Record<string, unknown>,
): { removed: string[]; skipped: string[] } {
	if (fields.length === 0) return { removed: [], skipped: [] };
	// LOW (c): `acquireConfigLock` opens `~/.mnemex/config.lock` with "wx". Without
	// the directory it fails ENOENT on every iteration and burns the whole 2 s
	// budget before discovering there is no config to edit. `saveGlobalConfig`
	// already does this; this path did not.
	ensureGlobalConfigDir();
	return withConfigLock(() => {
		const existing = readGlobalConfigFileRaw().parsed;
		if (!existing) return { removed: [], skipped: [] };
		const removed: string[] = [];
		const skipped: string[] = [];
		for (const field of fields) {
			if (
				expectedValues &&
				field in expectedValues &&
				existing[field] !== expectedValues[field]
			) {
				skipped.push(field);
				continue;
			}
			delete existing[field];
			removed.push(field);
		}
		if (removed.length === 0) return { removed, skipped };
		writeGlobalConfigFileAtomic(existing);
		invalidateSecretSessionCache();
		return { removed, skipped };
	});
}

/**
 * Tighten `~/.mnemex/config.json` to 0600 WITHOUT touching its contents.
 *
 * `mnemex keychain migrate` deliberately leaves the plaintext copies in place —
 * copy-verify-then-separately-delete is the only shape in which an interrupted
 * migration cannot lose a key. But it performed no save either, so on the verified
 * starting state for every upgrading user (a 0644 file, which is what
 * `writeFileSync`'s `mode:` cannot fix on an existing file) every plaintext copy
 * stayed WORLD-READABLE for the whole validation interval the two-step migration
 * asks the user to sit in. CWE-732.
 *
 * Returns false when the mode could not be confirmed, so the caller can say so and
 * fail rather than implying the file is protected.
 */
export function hardenGlobalConfigFileMode(): boolean {
	try {
		if (!existsSync(GLOBAL_CONFIG_PATH)) return true;
		chmodSync(GLOBAL_CONFIG_PATH, 0o600);
		return (statSync(GLOBAL_CONFIG_PATH).mode & 0o777) === 0o600;
	} catch {
		return false;
	}
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

	// The learning decision is cached per path; a rewrite must be visible.
	resetLearningEnabledCache();
}

// ============================================================================
// Project Paths
// ============================================================================

/**
 * Get the index directory for a project
 * Respects custom indexDir from project config
 */
export function getIndexDir(projectPath: string): string {
	const projectConfig = loadProjectConfig(projectPath);
	if (projectConfig?.indexDir) {
		// If indexDir is absolute, use it directly
		if (projectConfig.indexDir.startsWith("/")) {
			return projectConfig.indexDir;
		}
		// Otherwise, treat as relative to project root
		return join(projectPath, projectConfig.indexDir);
	}
	return join(projectPath, PROJECT_CONFIG_DIR);
}

/**
 * Get the path to the project's index database
 */
export function getIndexDbPath(projectPath: string): string {
	return join(getIndexDir(projectPath), INDEX_DB_FILE);
}

/**
 * Get the path to the project's vector store
 */
export function getVectorStorePath(projectPath: string): string {
	return join(getIndexDir(projectPath), VECTORS_DIR);
}

/**
 * Get the path to the global models cache
 */
export function getModelsCachePath(): string {
	return join(GLOBAL_CONFIG_DIR, MODELS_CACHE_FILE);
}

/**
 * Ensure project config directory exists
 */
export function ensureProjectDir(projectPath: string): void {
	const configDir = getIndexDir(projectPath);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Create CACHEDIR.TAG to mark as cache directory
	const cacheTagPath = join(configDir, "CACHEDIR.TAG");
	if (!existsSync(cacheTagPath)) {
		writeFileSync(
			cacheTagPath,
			"Signature: 8a477f597d28d172789f06886806bc55\n# This file marks the directory as a cache directory.\n# For more information see https://bford.info/cachedir/\n",
			"utf-8",
		);
	}
}

// ============================================================================
// API Key Management
// ============================================================================

/**
 * Get OpenRouter API key.
 * Order: OPENROUTER_API_KEY -> macOS Keychain -> ~/.mnemex/config.json.
 */
export function getApiKey(): string | undefined {
	return resolveSecret("openrouter", () => loadGlobalConfig().openrouterApiKey);
}

/**
 * Check if API key is configured
 */
export function hasApiKey(): boolean {
	return !!getApiKey();
}

/**
 * Get Voyage AI API key.
 * Order: VOYAGE_API_KEY -> macOS Keychain -> ~/.mnemex/config.json.
 */
export function getVoyageApiKey(): string | undefined {
	return resolveSecret("voyage", () => loadGlobalConfig().voyageApiKey);
}

/**
 * Check if Voyage API key is configured
 */
export function hasVoyageApiKey(): boolean {
	return !!getVoyageApiKey();
}

/**
 * Get the configured embedding provider.
 * Priority: global config > default ('openrouter')
 */
export function getEmbeddingProvider(): EmbeddingProvider {
	const globalConfig = loadGlobalConfig();
	return globalConfig.embeddingProvider || "openrouter";
}

/** Local embedding providers (no network API call to cloud) */
export const LOCAL_EMBEDDING_PROVIDERS: Set<EmbeddingProvider> = new Set([
	"ollama",
	"lmstudio",
	"local",
]);

/**
 * Check if the configured embedding provider has valid credentials.
 * Local providers (ollama, lmstudio, local) need no API key.
 */
export function hasValidEmbeddingCredentials(): boolean {
	const provider = getEmbeddingProvider();
	if (LOCAL_EMBEDDING_PROVIDERS.has(provider)) {
		return true;
	}
	if (provider === "voyage") {
		return hasVoyageApiKey();
	}
	// openrouter or unknown
	return hasApiKey();
}

/**
 * Get embedding model from environment or config
 */
export function getEmbeddingModel(projectPath?: string): string {
	// First check environment variable
	const envModel = process.env[ENV.MNEMEX_MODEL];
	if (envModel) {
		return envModel;
	}

	// Then check project config
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.embeddingModel) {
			return projectConfig.embeddingModel;
		}
	}

	// Then check global config
	const globalConfig = loadGlobalConfig();
	if (globalConfig.defaultModel) {
		return globalConfig.defaultModel;
	}

	// Fall back to default
	return DEFAULT_EMBEDDING_MODEL;
}

// ============================================================================
// LLM Configuration (for Enrichment)
// ============================================================================

import { LLMResolver, type LLMSpec } from "./llm/resolver.js";

/**
 * Get Anthropic API key.
 * Order: ANTHROPIC_API_KEY -> macOS Keychain -> ~/.mnemex/config.json.
 */
export function getAnthropicApiKey(): string | undefined {
	return resolveSecret("anthropic", () => loadGlobalConfig().anthropicApiKey);
}

/**
 * Get the Ollama API key.
 * Order: OLLAMA_API_KEY -> macOS Keychain -> ~/.mnemex/config.json.
 *
 * GENERATION ONLY. `OllamaEmbeddingsClient` sends no auth header and must keep
 * sending none: Ollama Cloud's `/api/embed` returns 401 for EVERY model, so a key
 * on the embeddings path turns a working local-Ollama embedding run into a
 * confusing failure (CLAUDE.md #18). Do not "fix" the asymmetry.
 */
export function getOllamaApiKey(): string | undefined {
	return resolveSecret("ollama", () => loadGlobalConfig().ollamaApiKey);
}

/**
 * Check if Anthropic API key is configured
 */
export function hasAnthropicApiKey(): boolean {
	return !!getAnthropicApiKey();
}

/**
 * Get unified LLM spec from environment or config.
 * Supports specs like "a/sonnet", "or/openai/gpt-4o", "cc/sonnet".
 *
 * Priority: MNEMEX_LLM env > project config llm > global config llm > default (cc/sonnet)
 */
export function getLLMSpec(projectPath?: string): LLMSpec {
	// 1. Check unified MNEMEX_LLM env var
	const envSpec = process.env[ENV.MNEMEX_LLM];
	if (envSpec) {
		return LLMResolver.parseSpec(envSpec);
	}

	// 2. Check project config
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.enrichmentModel) {
			return LLMResolver.parseSpec(projectConfig.enrichmentModel);
		}
	}

	// 3. Check global config
	const globalConfig = loadGlobalConfig();
	if (globalConfig.llm) {
		return LLMResolver.parseSpec(globalConfig.llm);
	}

	// 4. Default to claude-code
	return LLMResolver.parseSpec("cc/sonnet");
}

/**
 * Check if enrichment is enabled
 * Priority: project config > global config > default (true)
 */
export function isEnrichmentEnabled(projectPath?: string): boolean {
	// Check project override first
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.enrichment !== undefined) {
			return projectConfig.enrichment;
		}
	}

	// Fall back to global config (default: true)
	const globalConfig = loadGlobalConfig();
	return globalConfig.enableEnrichment !== false;
}

/**
 * Check if vector embeddings are enabled
 * Priority: project config > default (true)
 * When false, only BM25 keyword search is used - no embedding API needed.
 */
export function isVectorEnabled(projectPath?: string): boolean {
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.vector !== undefined) {
			return projectConfig.vector;
		}
	}
	// Default: true (vector embeddings enabled)
	return true;
}

// ============================================================================
// Documentation Fetching Configuration
// ============================================================================

import type { DocProviderType, DocsConfig } from "./types.js";

/**
 * Get Context7 API key from environment or config
 * Priority: env > project config > global config
 */
export function getContext7ApiKey(projectPath?: string): string | undefined {
	return resolveSecret(
		"context7",
		() =>
			(projectPath
				? loadProjectConfig(projectPath)?.docs?.context7ApiKey
				: undefined) || loadGlobalConfig().context7ApiKey,
	);
}

/**
 * Check if Context7 API key is configured
 */
export function hasContext7ApiKey(projectPath?: string): boolean {
	return !!getContext7ApiKey(projectPath);
}

/**
 * Check if documentation fetching is enabled
 * Priority: env > project config > default (true if any provider can work)
 */
export function isDocsEnabled(projectPath?: string): boolean {
	// Check environment variable first
	const envEnabled = process.env[ENV.MNEMEX_DOCS_ENABLED];
	if (envEnabled !== undefined) {
		return envEnabled.toLowerCase() !== "false" && envEnabled !== "0";
	}

	// Check project config
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.docs?.enabled !== undefined) {
			return projectConfig.docs.enabled;
		}
	}

	// Default: true (llms.txt and DevDocs work without API keys)
	return true;
}

/**
 * Get documentation configuration with defaults applied
 */
export function getDocsConfig(projectPath?: string): Required<DocsConfig> {
	const projectConfig = projectPath ? loadProjectConfig(projectPath) : null;
	const docsConfig = projectConfig?.docs ?? {};

	return {
		enabled: isDocsEnabled(projectPath),
		context7ApiKey: getContext7ApiKey(projectPath) ?? "",
		providers:
			docsConfig.providers ??
			(["context7", "llms_txt", "devdocs"] as DocProviderType[]),
		cacheTTL: docsConfig.cacheTTL ?? DEFAULT_DOCS_CACHE_TTL,
		excludeLibraries: docsConfig.excludeLibraries ?? [],
		maxPagesPerLibrary: docsConfig.maxPagesPerLibrary ?? DEFAULT_DOCS_MAX_PAGES,
	};
}

/**
 * Get path to docs cache directory
 */
export function getDocsCachePath(projectPath: string): string {
	return join(getIndexDir(projectPath), "docs-cache");
}

// ============================================================================
// Test File Handling
// ============================================================================

/** Test file handling mode */
export type TestFileMode = "downrank" | "exclude" | "include";

// ============================================================================
// Embedding Model Mismatch Handling
// ============================================================================

/**
 * What to do when the model recorded in an index is not the configured one.
 * - 'use-indexed': keep the index, switch to the model that built it
 * - 'force-model': clear the index and rebuild it with the configured model
 */
export type ModelMismatchMode = "use-indexed" | "force-model";

/** Every accepted value, so an unrecognised one can be told apart from a valid one. */
const MODEL_MISMATCH_MODES = new Set<string>([
	"use-indexed",
	"force-model",
] satisfies ModelMismatchMode[]);

/**
 * Narrow an untrusted value (env var, JSON config) to a mode, or undefined.
 *
 * Undefined for anything unrecognised so the caller falls through to the next
 * level of the precedence chain instead of failing: a typo in one config file
 * should not be able to stop a search.
 */
function asModelMismatchMode(value: unknown): ModelMismatchMode | undefined {
	return typeof value === "string" && MODEL_MISMATCH_MODES.has(value)
		? (value as ModelMismatchMode)
		: undefined;
}

// ============================================================================
// Self-Learning Configuration
// ============================================================================

/**
 * Cached learning decision per project path.
 *
 * The learning flag is written once (by `mnemex init` / the setup wizard) and
 * read on every search, so a filesystem read per search would be pure
 * overhead. `saveGlobalConfig` / `saveProjectConfig` drop the cache so an
 * in-process rewrite still takes effect.
 */
const learningEnabledCache = new Map<string, boolean>();

/** Cache key for the global-only lookup (no project path given). */
const GLOBAL_LEARNING_CACHE_KEY = "\0global";

/**
 * Uncached read of the learning flag.
 *
 * Learning is opt-OUT: only an explicit `false` on record turns it off. A
 * missing or unreadable config is not an opt-out, so it fails OPEN — users who
 * never configured anything keep the behaviour they already have.
 */
function readLearningEnabled(projectPath?: string): boolean {
	try {
		// Explicit project value wins over the global one.
		if (projectPath) {
			const projectConfig = loadProjectConfig(projectPath);
			if (typeof projectConfig?.learning === "boolean") {
				return projectConfig.learning;
			}
		}

		// Project config is silent (or absent): `mnemex init` records the answer
		// in the global config. Default when nobody said anything: enabled.
		return loadGlobalConfig().learning !== false;
	} catch {
		return true;
	}
}

/**
 * Whether the self-learning system is enabled for this project.
 *
 * THE single source of truth for "is learning on?". Both entry points — the
 * CLI (`src/cli.ts`) and the MCP search tools (`src/mcp/tools/deps.ts`) — must
 * call this and nothing else, so one config state cannot mean two things.
 *
 * Priority: explicit project config > explicit global config > default (true).
 *
 * Cheap by construction: at most one config read per project path for the
 * lifetime of the process, and never a database open.
 *
 * When enabled, mnemex tracks interactions and learns from user corrections
 * to improve search quality over time.
 */
export function isLearningEnabled(projectPath?: string): boolean {
	const key = projectPath ?? GLOBAL_LEARNING_CACHE_KEY;
	const cached = learningEnabledCache.get(key);
	if (cached !== undefined) return cached;

	const enabled = readLearningEnabled(projectPath);
	learningEnabledCache.set(key, enabled);
	return enabled;
}

/**
 * Drop the cached learning decisions. For tests, and for callers that rewrite
 * the config in-process.
 */
export function resetLearningEnabledCache(): void {
	learningEnabledCache.clear();
}

/**
 * Get test file handling mode for search results.
 * Priority: project config > default ('downrank')
 */
export function getTestFileMode(projectPath?: string): TestFileMode {
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.testFiles !== undefined) {
			return projectConfig.testFiles;
		}
	}
	// Default: downrank test files in search results
	return "downrank";
}

/**
 * Get what to do when the index's embedding model is not the configured one.
 *
 * Priority: MNEMEX_ON_MODEL_MISMATCH env > project config > global config >
 * default ('use-indexed'). Deliberately the same chain as getEmbeddingModel():
 * this setting only ever matters together with that one, and two settings read
 * as a pair must be overridable at the same levels.
 *
 * Default rationale: rebuilding costs money and time and throws away vectors
 * that are still perfectly good — just built by another model. Adopting the
 * stored model costs nothing and loses nothing, and when the stored model is
 * unreachable the failure is loud and the index survives it. 'force-model'
 * fails the other way: a silent charge for a rebuild nobody asked for.
 */
export function getModelMismatchMode(projectPath?: string): ModelMismatchMode {
	// Environment first, so a one-off run can override without editing config.
	const fromEnv = asModelMismatchMode(
		process.env[ENV.MNEMEX_ON_MODEL_MISMATCH],
	);
	if (fromEnv) {
		return fromEnv;
	}

	// Then the project, which knows more about its own index than the machine does.
	if (projectPath) {
		const fromProject = asModelMismatchMode(
			loadProjectConfig(projectPath)?.onModelMismatch,
		);
		if (fromProject) {
			return fromProject;
		}
	}

	// Then the machine-wide preference.
	const fromGlobal = asModelMismatchMode(loadGlobalConfig().onModelMismatch);
	if (fromGlobal) {
		return fromGlobal;
	}

	// Default: keep the index, adopt the model that built it.
	return "use-indexed";
}
