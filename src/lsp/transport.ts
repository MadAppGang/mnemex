/**
 * LSP Transport
 *
 * JSON-RPC over stdio with Content-Length framing.
 * Handles message serialization, request/response correlation, and timeouts.
 */

import type { ChildProcess } from "node:child_process";

const MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB safety cap

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export class LspTransport {
	private buffer = Buffer.alloc(0);
	private contentLength = -1;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();

	/** Notification handler for server-initiated messages */
	onNotification?: (method: string, params: unknown) => void;

	/**
	 * Process incoming data from the LSP server's stdout.
	 */
	onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		// Safety: clear buffer if it grows too large
		if (this.buffer.length > MAX_BUFFER_SIZE) {
			this.buffer = Buffer.alloc(0);
			this.contentLength = -1;
			this.cancelAll(new Error("Buffer overflow — LSP transport reset"));
			return;
		}

		while (true) {
			if (this.contentLength === -1) {
				// Look for header boundary
				const headerEnd = this.buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;

				const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
				const match = header.match(/Content-Length:\s*(\d+)/i);
				if (!match) {
					// Skip malformed header
					this.buffer = this.buffer.subarray(headerEnd + 4);
					continue;
				}

				this.contentLength = parseInt(match[1], 10);
				this.buffer = this.buffer.subarray(headerEnd + 4);
			}

			if (this.buffer.length < this.contentLength) break;

			const body = this.buffer
				.subarray(0, this.contentLength)
				.toString("utf-8");
			this.buffer = this.buffer.subarray(this.contentLength);
			this.contentLength = -1;

			try {
				const message = JSON.parse(body) as JsonRpcMessage;
				this.handleMessage(message);
			} catch {
				// Skip unparseable messages
			}
		}
	}

	/**
	 * Send a request and wait for the response.
	 */
	sendRequest<T>(
		process: ChildProcess,
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<T> {
		const id = this.nextId++;

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

			this.writeMessage(process, { jsonrpc: "2.0", id, method, params });
		});
	}

	/**
	 * Send a notification (no response expected).
	 */
	sendNotification(
		process: ChildProcess,
		method: string,
		params: unknown,
	): void {
		this.writeMessage(process, { jsonrpc: "2.0", method, params });
	}

	/**
	 * Cancel all pending requests (e.g., on crash).
	 */
	cancelAll(reason: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
	}

	/**
	 * Check if there are pending requests.
	 */
	hasPending(): boolean {
		return this.pending.size > 0;
	}

	private handleMessage(message: JsonRpcMessage): void {
		// Response to a request
		if (
			message.id !== undefined &&
			(message.result !== undefined || message.error)
		) {
			const pending = this.pending.get(message.id);
			if (pending) {
				this.pending.delete(message.id);
				clearTimeout(pending.timer);

				if (message.error) {
					pending.reject(
						new Error(
							`LSP error ${message.error.code}: ${message.error.message}`,
						),
					);
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}

		// Server notification
		if (message.method && message.id === undefined) {
			this.onNotification?.(message.method, message.params);
		}
	}

	private writeMessage(process: ChildProcess, message: JsonRpcMessage): void {
		if (!process.stdin || process.stdin.destroyed) {
			throw new Error("LSP process stdin is not available");
		}

		const body = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
		process.stdin.write(header + body);
	}
}
