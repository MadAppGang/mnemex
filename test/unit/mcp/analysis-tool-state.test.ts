/**
 * Tool-level tests for the analysis + search index-state wiring.
 *
 * Asserts dead_code / test_gaps still return their domain results AND carry the
 * additive index-state block: canReturnCachedResults, an indexing{} block when a
 * live lock is present, and a caveat (recommendations non-empty) when stale.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import { IndexStateManager } from "../../../src/mcp/state-manager.js";
import { registerAnalysisTools } from "../../../src/mcp/tools/analysis.js";
import type { ToolDeps } from "../../../src/mcp/tools/deps.js";

const LOCK_FILENAME = ".indexing.lock";
const tempDirs: string[] = [];

interface CapturedTool {
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
}

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
			tools.set(name, { handler });
		},
	};
	return { server, tools };
}

function makeIndexDir(): string {
	const root = mkdtempSync(join(tmpdir(), "analysis-state-test-"));
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

async function makeDeps(indexDir: string): Promise<ToolDeps> {
	const stateManager = new IndexStateManager(
		indexDir,
		resolveStoreLocation(dirname(indexDir)),
	);
	await stateManager.initialize();
	// Empty-symbol tracker double: analyzer returns empty result sets, which is
	// fine — we are testing the additive index-state envelope, not analysis logic.
	// The symbol graph is reached only through `tracker.graph(branchId)` now
	// (§4.4.1), so the double provides the handle rather than the members.
	const graph = {
		getAllSymbols: () => [],
		getSymbol: () => null,
	};
	const tracker = {
		graph: () => graph,
		getStats: () => ({ totalFiles: 5, lastIndexed: null }),
	};
	const cache = { get: async () => ({ tracker, branchId: 0 }) };
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		cache: cache as any,
		stateManager,
		// biome-ignore lint/suspicious/noExplicitAny: only indexDir/workspaceRoot used
		config: { indexDir, workspaceRoot: join(indexDir, "..") } as any,
		// biome-ignore lint/suspicious/noExplicitAny: logger stub
		logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
		serverStartTime: Date.now(),
		watcherActive: false,
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

describe("analysis tools index-state wiring", () => {
	test("dead_code: returns results + canReturnCachedResults + caveat when stale", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const deps = await makeDeps(indexDir);
		deps.stateManager.recordChange("src/foo.ts"); // stale

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerAnalysisTools(server as any, deps);
		const result = await tools.get("dead_code")!.handler({ limit: 50 });
		const json = parse(result);

		// Domain results still present
		expect(json.deadSymbols).toBeDefined();
		expect(json.totalAnalyzed).toBeDefined();
		// Additive index-state envelope
		expect(json.canReturnCachedResults).toBe(true);
		expect(json.status).toBe("stale");
		expect(Array.isArray(json.recommendations)).toBe(true);
		expect((json.recommendations as unknown[]).length).toBeGreaterThan(0);
		// Existing freshness preserved
		expect(json.freshness).toBe("stale");
		expect(json.reindexingInProgress).toBe(false);
	});

	test("test_gaps: includes indexing{} block when a live lock is present", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLiveLock(indexDir);
		const deps = await makeDeps(indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerAnalysisTools(server as any, deps);
		const result = await tools.get("test_gaps")!.handler({ limit: 30 });
		const json = parse(result);

		expect(json.untestedSymbols).toBeDefined();
		expect(json.status).toBe("indexing_in_progress");
		expect(json.indexing).not.toBeNull();
		expect(json.canReturnCachedResults).toBe(true);
	});

	test("freshness keys appear exactly once (no duplicate-key collision)", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const deps = await makeDeps(indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerAnalysisTools(server as any, deps);
		const result = await tools.get("dead_code")!.handler({ limit: 50 });
		const raw = result.content[0].text;

		// responseTimeMs is owned solely by buildFreshness; assert it appears once.
		const occurrences = raw.split('"responseTimeMs"').length - 1;
		expect(occurrences).toBe(1);
		// And the JSON parses (no structural issue from the double spread).
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
