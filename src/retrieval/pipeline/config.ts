/**
 * Pipeline Configuration
 *
 * Configuration for the parallel search pipeline backends.
 * Reads MNEMEX_PIPELINE_* environment variables.
 */

// ============================================================================
// Types
// ============================================================================

export interface PipelineConfig {
	/** Enable/disable individual backends */
	backends: {
		/** Symbol graph backend (default: true) */
		symbolGraph: boolean;
		/** LSP backend (default: true when LSP is enabled) */
		lsp: boolean;
		/** Tree-sitter structural backend (default: true) */
		treeSitter: boolean;
		/** Semantic/BM25 backend (default: true) */
		semantic: boolean;
		/** Location/glob backend (default: true) */
		location: boolean;
	};

	/** Minimum router confidence to activate non-semantic backends (default: 0.7) */
	routerMinConfidence: number;

	/** Per-backend score weights for RRF tie-breaking */
	backendWeights: {
		/** Slight boost for exact graph match (default: 1.2) */
		symbolGraph: number;
		/** Highest trust — LSP exact match (default: 1.5) */
		lsp: number;
		/** Tree-sitter structural (default: 1.1) */
		treeSitter: number;
		/** Semantic/BM25 (default: 1.0) */
		semantic: number;
		/** Location/glob (default: 0.9) */
		location: number;
	};

	/** Short-circuit on definitive LSP match (default: true) */
	lspShortCircuit: boolean;

	/** Enable LLM reranking within semantic backend (default: false) */
	semanticReranking: boolean;

	/** Enable LLM reranking of final merged results (default: false) */
	mergedReranking: boolean;

	/** Tree-sitter backend settings */
	treeSitterConfig: {
		/** Max files to scan before falling back to semantic pre-filter (default: 2000) */
		maxFilesToScan: number;
	};

	/** RRF k parameter (default: 60) */
	rrfK: number;
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
	backends: {
		symbolGraph: true,
		lsp: true,
		treeSitter: true,
		semantic: true,
		location: true,
	},
	routerMinConfidence: 0.7,
	backendWeights: {
		symbolGraph: 1.2,
		lsp: 1.5,
		treeSitter: 1.1,
		semantic: 1.0,
		location: 0.9,
	},
	lspShortCircuit: true,
	semanticReranking: false,
	mergedReranking: false,
	treeSitterConfig: {
		maxFilesToScan: 2000,
	},
	rrfK: 60,
};

// ============================================================================
// Loader
// ============================================================================

/**
 * Load pipeline config from MNEMEX_PIPELINE_* env vars, falling back to defaults.
 */
export function loadPipelineConfig(): PipelineConfig {
	const d = DEFAULT_PIPELINE_CONFIG;

	return {
		backends: {
			symbolGraph: parseBool(
				process.env.MNEMEX_PIPELINE_SYMBOL_GRAPH,
				d.backends.symbolGraph,
			),
			lsp: parseBool(process.env.MNEMEX_PIPELINE_LSP, d.backends.lsp),
			treeSitter: parseBool(
				process.env.MNEMEX_PIPELINE_TREE_SITTER,
				d.backends.treeSitter,
			),
			semantic: parseBool(
				process.env.MNEMEX_PIPELINE_SEMANTIC,
				d.backends.semantic,
			),
			location: parseBool(
				process.env.MNEMEX_PIPELINE_LOCATION,
				d.backends.location,
			),
		},
		routerMinConfidence: parseFloatEnv(
			process.env.MNEMEX_PIPELINE_ROUTER_CONFIDENCE,
			d.routerMinConfidence,
		),
		backendWeights: {
			symbolGraph: d.backendWeights.symbolGraph,
			lsp: d.backendWeights.lsp,
			treeSitter: d.backendWeights.treeSitter,
			semantic: d.backendWeights.semantic,
			location: d.backendWeights.location,
		},
		lspShortCircuit: parseBool(
			process.env.MNEMEX_PIPELINE_LSP_SHORT_CIRCUIT,
			d.lspShortCircuit,
		),
		semanticReranking: parseBool(
			process.env.MNEMEX_PIPELINE_SEMANTIC_RERANKING,
			d.semanticReranking,
		),
		mergedReranking: parseBool(
			process.env.MNEMEX_PIPELINE_MERGED_RERANKING,
			d.mergedReranking,
		),
		treeSitterConfig: {
			maxFilesToScan: parseIntEnv(
				process.env.MNEMEX_PIPELINE_TS_MAX_FILES,
				d.treeSitterConfig.maxFilesToScan,
			),
		},
		rrfK: parseIntEnv(process.env.MNEMEX_PIPELINE_RRF_K, d.rrfK),
	};
}

// ============================================================================
// Helpers
// ============================================================================

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value === "") return defaultValue;
	return value === "true" || value === "1";
}

function parseFloatEnv(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseFloat(value);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}
