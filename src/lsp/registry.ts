/**
 * Language Server Registry
 *
 * Configuration for supported language servers.
 * Commands can be overridden via environment variables.
 */

export interface LanguageServerConfig {
	/** Language identifier (matches EXT_TO_SERVER_LANG in manager.ts) */
	language: string;
	/** Command to spawn */
	command: string;
	/** Command arguments */
	args: string[];
	/** Initialization options for the server */
	initializationOptions?: unknown;
	/** File/directory to detect if this language is used in the project */
	rootDetector?: string;
}

/**
 * Built-in language server configurations.
 * Keys match the server language identifiers used in LspManager.
 */
export const LANGUAGE_SERVER_CONFIGS: Record<string, LanguageServerConfig> = {
	typescript: {
		language: "typescript",
		command: process.env.CLAUDEMEM_LSP_TS_CMD ?? "typescript-language-server",
		args: ["--stdio"],
		initializationOptions: {
			preferences: {
				includeInlayParameterNameHints: "none",
				includeInlayVariableTypeHints: false,
			},
		},
		rootDetector: "tsconfig.json",
	},

	python: {
		language: "python",
		command: process.env.CLAUDEMEM_LSP_PY_CMD ?? "pylsp",
		args: [],
		rootDetector: "pyproject.toml",
	},

	go: {
		language: "go",
		command: process.env.CLAUDEMEM_LSP_GO_CMD ?? "gopls",
		args: ["serve"],
		rootDetector: "go.mod",
	},

	rust: {
		language: "rust",
		command: process.env.CLAUDEMEM_LSP_RS_CMD ?? "rust-analyzer",
		args: [],
		rootDetector: "Cargo.toml",
	},
};
