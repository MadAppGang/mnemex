/**
 * LSP Client
 *
 * Manages a single language server process lifecycle:
 * spawn → initialize → ready → handle requests → shutdown.
 *
 * State machine: Unstarted → Initializing → Ready → Crashed → Dead
 */

import { spawn, type ChildProcess } from "node:child_process";
import { LspTransport } from "./transport.js";
import {
	LSP_METHODS,
	pathToUri,
	type ClientCapabilities,
	type InitializeResult,
	type TextDocumentContentChangeEvent,
} from "./protocol.js";

export type LspState =
	| "unstarted"
	| "initializing"
	| "ready"
	| "crashed"
	| "dead";

export interface LspClientConfig {
	/** Command to run (e.g., "typescript-language-server") */
	command: string;
	/** Command arguments */
	args: string[];
	/** Workspace root for rootUri */
	rootUri: string;
	/** Initialization options to send to the server */
	initializationOptions?: unknown;
	/** Request timeout in ms */
	timeoutMs: number;
}

/** Files currently open in the server */
interface OpenFile {
	uri: string;
	languageId: string;
	version: number;
	content: string;
}

export class LspClient {
	private process: ChildProcess | null = null;
	private transport = new LspTransport();
	private state: LspState = "unstarted";
	private openFiles = new Map<string, OpenFile>();
	private capabilities: InitializeResult["capabilities"] | null = null;
	private restartAttempted = false;

	constructor(private config: LspClientConfig) {}

	getState(): LspState {
		return this.state;
	}

	getCapabilities(): InitializeResult["capabilities"] | null {
		return this.capabilities;
	}

	/**
	 * Start the language server and complete initialization.
	 */
	async start(): Promise<void> {
		if (this.state !== "unstarted" && this.state !== "crashed") {
			throw new Error(`Cannot start LSP client in state: ${this.state}`);
		}

		this.state = "initializing";

		try {
			this.process = spawn(this.config.command, this.config.args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			this.process.stdout!.on("data", (chunk: Buffer) => {
				this.transport.onData(chunk);
			});

			this.process.on("exit", (code) => {
				if (this.state === "ready") {
					this.state = "crashed";
					this.transport.cancelAll(
						new Error(`LSP server exited with code ${code}`),
					);
					this.tryRestart();
				}
			});

			this.process.on("error", (err) => {
				this.state = "crashed";
				this.transport.cancelAll(err);
			});

			// Send initialize request with timeout
			const clientCapabilities: ClientCapabilities = {
				textDocument: {
					synchronization: { didSave: true },
					definition: { dynamicRegistration: false },
					references: { dynamicRegistration: false },
					hover: { contentFormat: ["markdown", "plaintext"] },
					rename: { prepareSupport: false },
				},
				workspace: {
					workspaceEdit: { documentChanges: true },
				},
			};

			const result = await this.transport.sendRequest<InitializeResult>(
				this.process,
				LSP_METHODS.INITIALIZE,
				{
					processId: process.pid,
					rootUri: this.config.rootUri,
					capabilities: clientCapabilities,
					initializationOptions: this.config.initializationOptions,
				},
				this.config.timeoutMs,
			);

			this.capabilities = result.capabilities;

			// Send initialized notification
			this.transport.sendNotification(
				this.process,
				LSP_METHODS.INITIALIZED,
				{},
			);

			this.state = "ready";
		} catch (err) {
			this.state = "crashed";
			this.kill();
			throw err;
		}
	}

	/**
	 * Send a request to the LSP server.
	 */
	async request<T>(method: string, params: unknown): Promise<T> {
		if (this.state !== "ready" || !this.process) {
			throw new Error(`LSP client not ready (state: ${this.state})`);
		}

		return this.transport.sendRequest<T>(
			this.process,
			method,
			params,
			this.config.timeoutMs,
		);
	}

	/**
	 * Open a file in the language server.
	 */
	openFile(filePath: string, languageId: string, content: string): void {
		if (this.state !== "ready" || !this.process) return;

		const uri = pathToUri(filePath);
		const version = 1;

		this.openFiles.set(filePath, { uri, languageId, version, content });

		this.transport.sendNotification(this.process, LSP_METHODS.DID_OPEN, {
			textDocument: { uri, languageId, version, text: content },
		});
	}

	/**
	 * Notify the server of a file content change.
	 */
	notifyChange(filePath: string, content: string): void {
		if (this.state !== "ready" || !this.process) return;

		const file = this.openFiles.get(filePath);
		if (!file) return;

		file.version++;
		file.content = content;

		const changes: TextDocumentContentChangeEvent[] = [{ text: content }];

		this.transport.sendNotification(this.process, LSP_METHODS.DID_CHANGE, {
			textDocument: { uri: file.uri, version: file.version },
			contentChanges: changes,
		});
	}

	/**
	 * Notify the server of a file save.
	 */
	notifySave(filePath: string, content: string): void {
		if (this.state !== "ready" || !this.process) return;

		const file = this.openFiles.get(filePath);
		if (!file) return;

		this.transport.sendNotification(this.process, LSP_METHODS.DID_SAVE, {
			textDocument: { uri: file.uri },
			text: content,
		});
	}

	/**
	 * Gracefully shut down the language server.
	 */
	async shutdown(): Promise<void> {
		if (this.state === "dead") return;

		if (this.state === "ready" && this.process) {
			try {
				// Close all open files
				for (const [, file] of this.openFiles) {
					this.transport.sendNotification(this.process, LSP_METHODS.DID_CLOSE, {
						textDocument: { uri: file.uri },
					});
				}

				await this.transport.sendRequest(
					this.process,
					LSP_METHODS.SHUTDOWN,
					null,
					5000, // 5s timeout for shutdown
				);

				this.transport.sendNotification(
					this.process,
					LSP_METHODS.EXIT,
					undefined,
				);
			} catch {
				// If shutdown fails, kill it
			}
		}

		this.kill();
		this.state = "dead";
	}

	private kill(): void {
		if (this.process) {
			try {
				this.process.kill("SIGTERM");
			} catch {
				// already dead
			}
			this.process = null;
		}
	}

	/**
	 * Attempt one restart after a crash.
	 * Re-opens any previously tracked files.
	 */
	private async tryRestart(): Promise<void> {
		if (this.restartAttempted) {
			this.state = "dead";
			return;
		}

		this.restartAttempted = true;
		const filesToReopen = new Map(this.openFiles);
		this.openFiles.clear();
		this.kill();

		try {
			this.state = "unstarted";
			await this.start();

			// Re-open tracked files
			for (const [path, file] of filesToReopen) {
				this.openFile(path, file.languageId, file.content);
			}
		} catch {
			this.state = "dead";
		}
	}
}
