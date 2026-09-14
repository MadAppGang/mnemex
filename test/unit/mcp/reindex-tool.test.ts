/**
 * Tool-level tests for the `reindex` MCP tool.
 *
 * Covers:
 *  - already_running enrich (indexing/index/recommendations) — keeps discriminator
 *  - blocking timeout => status "timeout" + structured diagnostics; waitForCompletion
 *    invoked with REINDEX_BLOCKING_TIMEOUT_MS (45000)  [≤ client timeout]
 *  - A5: blocking with completionDetector UNDEFINED falls back (no timeout diagnostics)
 *  - A7: discriminator status strings preserved, not clobbered by IndexState.status
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import { IndexStateManager } from "../../../src/mcp/state-manager.js";
import type { ToolDeps } from "../../../src/mcp/tools/deps.js";
import { registerReindexTools } from "../../../src/mcp/tools/reindex.js";

const LOCK_FILENAME = ".indexing.lock";
const tempDirs: string[] = [];

interface CapturedTool {
	name: string;
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
}

/** A capturing fake McpServer that records each registered tool's handler. */
function makeCapturingServer(): {
	server: unknown;
	tools: Map<string, CapturedTool>;
} {
	const tools = new Map<string, CapturedTool>();
	const server = {
		tool(
			name: string,
			_desc: string,
			_schema: unknown,
			handler: CapturedTool["handler"],
		) {
			tools.set(name, { name, handler });
		},
	};
	return { server, tools };
}

function makeIndexDir(): string {
	const root = mkdtempSync(join(tmpdir(), "reindex-tool-test-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	return indexDir;
}

function writeIndexDb(indexDir: string): void {
	writeFileSync(join(indexDir, "index.db"), "fake sqlite bytes");
}

function writeLiveLock(indexDir: string): void {
	const now = Date.now();
	writeFileSync(
		join(indexDir, LOCK_FILENAME),
		JSON.stringify({
			pid: process.pid,
			startTime: now,
			heartbeat: now,
			startedAt: new Date(now).toISOString(),
		}),
	);
}

async function makeDeps(
	indexDir: string,
	overrides: Partial<ToolDeps> = {},
): Promise<ToolDeps> {
	const stateManager = new IndexStateManager(
		indexDir,
		resolveStoreLocation(dirname(indexDir)),
	);
	await stateManager.initialize();
	const cache = {
		get: async () => ({
			tracker: { getStats: () => ({ totalFiles: 3, lastIndexed: null }) },
		}),
	};
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		cache: cache as any,
		stateManager,
		// biome-ignore lint/suspicious/noExplicitAny: only indexDir/workspaceRoot used
		config: { indexDir, workspaceRoot: join(indexDir, "..") } as any,
		// biome-ignore lint/suspicious/noExplicitAny: logger stub
		logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
		serverStartTime: Date.now(),
		watcherActive: true,
		...overrides,
	};
}

function parse(result: {
	content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
	return JSON.parse(result.content[0].text);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	}
});

describe("reindex tool", () => {
	test("already_running: enriched with indexing/index/recommendations; discriminator preserved (A7)", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLiveLock(indexDir);

		const reindexer = { isRunning: () => true };
		const deps = await makeDeps(indexDir, {
			// biome-ignore lint/suspicious/noExplicitAny: reindexer stub
			reindexer: reindexer as any,
			completionDetector: undefined,
		});

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerReindexTools(server as any, deps);
		const result = await tools.get("reindex")!.handler({
			force: false,
			blocking: false,
		});
		const json = parse(result);

		// A7: discriminator NOT clobbered by indexState.status (which is indexing_in_progress)
		expect(json.status).toBe("already_running");
		expect(json.indexing).not.toBeNull();
		expect(json.index).toBeDefined();
		expect(Array.isArray(json.recommendations)).toBe(true);
	});

	test("blocking timeout: status 'timeout' + diagnostics; waitForCompletion called with 45000", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLiveLock(indexDir);

		let capturedTimeout: number | undefined;
		const completionDetector = {
			waitForCompletion: async (timeoutMs?: number) => {
				capturedTimeout = timeoutMs;
				return false; // simulate timeout
			},
		};
		const reindexer = { isRunning: () => true };
		const deps = await makeDeps(indexDir, {
			// biome-ignore lint/suspicious/noExplicitAny: stubs
			reindexer: reindexer as any,
			// biome-ignore lint/suspicious/noExplicitAny: stubs
			completionDetector: completionDetector as any,
		});

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerReindexTools(server as any, deps);
		const result = await tools.get("reindex")!.handler({
			force: false,
			blocking: true,
		});
		const json = parse(result);

		expect(json.status).toBe("timeout");
		expect(json.index).toBeDefined();
		expect(json.indexing).not.toBeNull();
		expect(json.canReturnCachedResults).toBe(true);
		expect(capturedTimeout).toBe(45000);
	});

	test("A5: blocking with completionDetector undefined falls back (no timeout diagnostics)", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLiveLock(indexDir);

		const reindexer = { isRunning: () => true };
		const deps = await makeDeps(indexDir, {
			// biome-ignore lint/suspicious/noExplicitAny: stub
			reindexer: reindexer as any,
			completionDetector: undefined, // <-- not in watch mode
		});

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerReindexTools(server as any, deps);
		const result = await tools.get("reindex")!.handler({
			force: false,
			blocking: true,
		});
		const json = parse(result);

		// Falls back to already_running (NOT timeout) since no completionDetector.
		expect(json.status).toBe("already_running");
	});

	test("not-running blocking timeout: status 'timeout' with diagnostics (force path)", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);

		let capturedTimeout: number | undefined;
		const completionDetector = {
			waitForCompletion: async (timeoutMs?: number) => {
				capturedTimeout = timeoutMs;
				return false;
			},
		};
		const reindexer = {
			isRunning: () => false,
			forceReindex: async () => {},
			scheduleReindex: () => {},
		};
		const deps = await makeDeps(indexDir, {
			// biome-ignore lint/suspicious/noExplicitAny: stubs
			reindexer: reindexer as any,
			// biome-ignore lint/suspicious/noExplicitAny: stubs
			completionDetector: completionDetector as any,
		});

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerReindexTools(server as any, deps);
		const result = await tools.get("reindex")!.handler({
			force: true,
			blocking: true,
		});
		const json = parse(result);

		expect(json.status).toBe("timeout");
		expect(capturedTimeout).toBe(45000);
		expect(json.index).toBeDefined();
	});

	test("no reindexer configured => status 'failed' (unchanged behavior)", async () => {
		const indexDir = makeIndexDir();
		const deps = await makeDeps(indexDir, { reindexer: undefined });

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerReindexTools(server as any, deps);
		const result = await tools.get("reindex")!.handler({
			force: false,
			blocking: false,
		});
		const json = parse(result);

		expect(json.status).toBe("failed");
	});
});
