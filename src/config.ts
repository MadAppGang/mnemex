/**
 * Configuration management for mnemex
 *
 * Handles both global config (~/.mnemex/config.json) and
 * project-specific config (.mnemex/config.json)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, GlobalConfig, ProjectConfig } from "./types.js";

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
 * Load global configuration from ~/.mnemex/config.json
 */
export function loadGlobalConfig(): GlobalConfig {
	const defaultConfig: GlobalConfig = {
		excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
	};

	if (!existsSync(GLOBAL_CONFIG_PATH)) {
		return defaultConfig;
	}

	try {
		const content = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
		const loaded = JSON.parse(content) as Partial<GlobalConfig>;
		return {
			...defaultConfig,
			...loaded,
			excludePatterns: [
				...DEFAULT_EXCLUDE_PATTERNS,
				...(loaded.excludePatterns || []),
			],
		};
	} catch (error) {
		console.warn("Failed to load global config:", error);
		return defaultConfig;
	}
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
				pattern = pattern + "**";
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

/**
 * Load merged configuration (global + project)
 */
export function loadConfig(projectPath: string): Config {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(projectPath);

	return {
		...global,
		project: project || undefined,
	};
}

/**
 * Save global configuration
 */
export function saveGlobalConfig(config: Partial<GlobalConfig>): void {
	// Ensure directory exists
	if (!existsSync(GLOBAL_CONFIG_DIR)) {
		mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	}

	// Merge with existing config
	const existing = loadGlobalConfig();
	const merged = { ...existing, ...config };

	writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
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
 * Get OpenRouter API key from environment or config
 */
export function getApiKey(): string | undefined {
	// First check environment variable
	const envKey = process.env[ENV.OPENROUTER_API_KEY];
	if (envKey) {
		return envKey;
	}

	// Then check global config
	const config = loadGlobalConfig();
	return config.openrouterApiKey;
}

/**
 * Check if API key is configured
 */
export function hasApiKey(): boolean {
	return !!getApiKey();
}

/**
 * Get Voyage AI API key from environment or config
 */
export function getVoyageApiKey(): string | undefined {
	// First check environment variable
	const envKey = process.env[ENV.VOYAGE_API_KEY];
	if (envKey) {
		return envKey;
	}

	// Then check global config
	const config = loadGlobalConfig();
	return config.voyageApiKey;
}

/**
 * Check if Voyage API key is configured
 */
export function hasVoyageApiKey(): boolean {
	return !!getVoyageApiKey();
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

import type { LLMProvider } from "./types.js";
import { LLMResolver, type LLMSpec } from "./llm/resolver.js";

/**
 * Get Anthropic API key from environment or config
 */
export function getAnthropicApiKey(): string | undefined {
	// First check environment variable
	const envKey = process.env[ENV.ANTHROPIC_API_KEY];
	if (envKey) {
		return envKey;
	}

	// Then check global config
	const config = loadGlobalConfig();
	return config.anthropicApiKey;
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

import type { DocsConfig, DocProviderType } from "./types.js";

/**
 * Get Context7 API key from environment or config
 * Priority: env > project config > global config
 */
export function getContext7ApiKey(projectPath?: string): string | undefined {
	// First check environment variable
	const envKey = process.env[ENV.CONTEXT7_API_KEY];
	if (envKey) {
		return envKey;
	}

	// Then check project config
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.docs?.context7ApiKey) {
			return projectConfig.docs.context7ApiKey;
		}
	}

	// Then check global config
	const config = loadGlobalConfig();
	return config.context7ApiKey;
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
// Self-Learning Configuration
// ============================================================================

/**
 * Check if self-learning system is enabled.
 * Priority: project config > global config > default (true)
 *
 * When enabled, mnemex tracks interactions and learns from user corrections
 * to improve search quality over time.
 */
export function isLearningEnabled(projectPath?: string): boolean {
	// Check project override first
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.learning !== undefined) {
			return projectConfig.learning;
		}
	}

	// Fall back to global config (default: true)
	const globalConfig = loadGlobalConfig();
	return globalConfig.learning !== false;
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
