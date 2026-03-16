/**
 * LSP Manager
 *
 * Manages multiple language server clients with lazy creation and LRU eviction.
 * Acts as the single entry point for all LSP operations.
 */

import { extname } from "node:path";
import { LspClient, type LspClientConfig } from "./client.js";
import {
	LANGUAGE_SERVER_CONFIGS,
	type LanguageServerConfig,
} from "./registry.js";
import { pathToUri } from "./protocol.js";

export interface LspManagerConfig {
	/** Whether LSP is enabled (MNEMEX_LSP, default false) */
	enabled: boolean;
	/** Request timeout in ms */
	timeoutMs: number;
	/** Maximum concurrent language servers */
	maxServers: number;
	/** Languages to disable */
	disabledLanguages: string[];
	/** Workspace root */
	workspaceRoot: string;
	/** Per-language command overrides */
	commandOverrides: Record<string, string>;
}

/** Extension → language ID mapping for LSP */
const EXT_TO_LANGUAGE_ID: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

/** Extension → server language key */
const EXT_TO_SERVER_LANG: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "typescript",
	".jsx": "typescript",
	".mjs": "typescript",
	".cjs": "typescript",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

export class LspManager {
	private clients = new Map<string, LspClient>();
	private lruOrder: string[] = []; // Most recently used at end
	private shuttingDown = false;

	constructor(private config: LspManagerConfig) {}

	/**
	 * Get or create a client for the given language.
	 * Returns null if LSP is disabled or the language is not supported.
	 */
	async getClient(language: string): Promise<LspClient | null> {
		if (!this.config.enabled || this.shuttingDown) return null;
		if (this.config.disabledLanguages.includes(language)) return null;

		// Check if we have a running client
		const existing = this.clients.get(language);
		if (existing && existing.getState() === "ready") {
			this.touchLru(language);
			return existing;
		}

		// Check if server config exists
		const serverConfig = LANGUAGE_SERVER_CONFIGS[language];
		if (!serverConfig) return null;

		// Evict if at capacity
		if (this.clients.size >= this.config.maxServers) {
			await this.evictLru();
		}

		// Create and start new client
		const client = this.createClient(language, serverConfig);
		this.clients.set(language, client);
		this.lruOrder.push(language);

		try {
			await client.start();
			return client;
		} catch {
			this.clients.delete(language);
			this.lruOrder = this.lruOrder.filter((l) => l !== language);
			return null;
		}
	}

	/**
	 * Get an existing client for a file (no creation).
	 */
	getClientForFile(filePath: string): LspClient | null {
		const lang = this.detectServerLanguage(filePath);
		if (!lang) return null;
		const client = this.clients.get(lang);
		return client?.getState() === "ready" ? client : null;
	}

	/**
	 * Detect the language ID for a file (for LSP didOpen).
	 */
	detectLanguageId(filePath: string): string | null {
		const ext = extname(filePath);
		return EXT_TO_LANGUAGE_ID[ext] ?? null;
	}

	/**
	 * Detect which server language handles this file.
	 */
	detectServerLanguage(filePath: string): string | null {
		const ext = extname(filePath);
		return EXT_TO_SERVER_LANG[ext] ?? null;
	}

	/**
	 * Notify all relevant clients that a file was saved.
	 */
	notifyFileSaved(filePath: string, content: string): void {
		const lang = this.detectServerLanguage(filePath);
		if (!lang) return;

		const client = this.clients.get(lang);
		if (client?.getState() === "ready") {
			client.notifySave(filePath, content);
		}
	}

	/**
	 * Gracefully shut down all language servers.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;

		const shutdowns = Array.from(this.clients.values()).map((client) =>
			client.shutdown().catch(() => {}),
		);

		await Promise.all(shutdowns);
		this.clients.clear();
		this.lruOrder = [];
	}

	private createClient(
		language: string,
		serverConfig: LanguageServerConfig,
	): LspClient {
		const override = this.config.commandOverrides[language];
		const command = override ?? serverConfig.command;

		const clientConfig: LspClientConfig = {
			command,
			args: serverConfig.args,
			rootUri: pathToUri(this.config.workspaceRoot),
			initializationOptions: serverConfig.initializationOptions,
			timeoutMs: this.config.timeoutMs,
		};

		return new LspClient(clientConfig);
	}

	private touchLru(language: string): void {
		this.lruOrder = this.lruOrder.filter((l) => l !== language);
		this.lruOrder.push(language);
	}

	private async evictLru(): Promise<void> {
		if (this.lruOrder.length === 0) return;

		const language = this.lruOrder.shift()!;
		const client = this.clients.get(language);
		if (client) {
			await client.shutdown().catch(() => {});
			this.clients.delete(language);
		}
	}
}
