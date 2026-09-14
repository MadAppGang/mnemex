/**
 * Tool-level tests for the `index_codebase` legacy MCP tool.
 *
 * Covers (validation-criteria.md + amendments):
 *  - case 1: live lock at the server workspace + omitted path => structured
 *    indexing_in_progress shape, does NOT throw, does NOT run the indexer.
 *  - A6 race: indexer.index() throws IndexLockError (after a lock appears) =>
 *    structured NON-error shape with status ∈ {indexing_in_progress, stale_lock}.
 *  - CRITICAL-1: caller path != workspace + workspace lock present => index
 *    PROCEEDS (pre-check is skipped, IndexLockError is NOT translated).
 *
 * createIndexer is module-mocked so we control index() and observe whether it ran.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import the REAL IndexLockError so `err instanceof IndexLockError` holds.
import { IndexLockError } from "../../../src/core/indexer.js";
import { resolveStoreLocation } from "../../../src/core/store-location.js";

const LOCK_FILENAME = ".indexing.lock";
const tempDirs: string[] = [];

// ── Module mock state ──────────────────────────────────────────────────────
// Controlled per-test. The mock createIndexer returns an indexer whose index()
// delegates to the current `indexBehavior`.
let indexCalled = false;
let indexBehavior: () => Promise<{
	filesIndexed: number;
	chunksCreated: number;
	durationMs: number;
	errors: Array<{ file: string; error: string }>;
}> = async () => ({
	filesIndexed: 1,
	chunksCreated: 2,
	durationMs: 10,
	errors: [],
});

mock.module("../../../src/core/indexer.js", () => ({
	IndexLockError,
	createIndexer: () => ({
		index: async (_force: boolean) => {
			indexCalled = true;
			return indexBehavior();
		},
		close: async () => {},
		getStatus: async () => ({ exists: false }),
	}),
}));

// NOTE: we deliberately do NOT mock ../../../src/core/tracker.js — Bun's
// mock.module is process-global and would leak into other suites that rely on
// the real FileTracker. getFileTracker(projectPath) only constructs a tracker
// when <projectPath>/.mnemex/index.db exists, and any failure there is caught
// silently in the tool, so the real module is safe to use here.

// Imported AFTER the mocks so it picks up the mocked createIndexer.
const { registerLegacyTools } = await import(
	"../../../src/mcp/tools/legacy.js"
);
const { IndexStateManager } = await import("../../../src/mcp/state-manager.js");
type ToolDeps = import("../../../src/mcp/tools/deps.js").ToolDeps;

interface CapturedTool {
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
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

function makeWorkspace(): { workspaceRoot: string; indexDir: string } {
	const root = mkdtempSync(join(tmpdir(), "index-codebase-test-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	return { workspaceRoot: root, indexDir };
}

function writeIndexDb(indexDir: string): void {
	writeFileSync(join(indexDir, "index.db"), "fake sqlite bytes");
}

function writeLock(indexDir: string, pid: number): void {
	const now = Date.now();
	writeFileSync(
		join(indexDir, LOCK_FILENAME),
		JSON.stringify({
			pid,
			startTime: now,
			heartbeat: now,
			startedAt: new Date(now).toISOString(),
		}),
	);
}

async function makeDeps(
	workspaceRoot: string,
	indexDir: string,
): Promise<ToolDeps> {
	const stateManager = new IndexStateManager(
		indexDir,
		resolveStoreLocation(workspaceRoot),
	);
	await stateManager.initialize();
	const cache = {
		get: async () => ({
			tracker: { getStats: () => ({ totalFiles: 1, lastIndexed: null }) },
		}),
	};
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		cache: cache as any,
		// biome-ignore lint/suspicious/noExplicitAny: real state manager
		stateManager: stateManager as any,
		// biome-ignore lint/suspicious/noExplicitAny: only indexDir/workspaceRoot used
		config: { indexDir, workspaceRoot } as any,
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

beforeEach(() => {
	indexCalled = false;
	indexBehavior = async () => ({
		filesIndexed: 1,
		chunksCreated: 2,
		durationMs: 10,
		errors: [],
	});
});

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

describe("index_codebase tool", () => {
	test("case 1: live workspace lock + omitted path => indexing_in_progress, indexer NOT run", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeIndexDb(indexDir);
		writeLock(indexDir, process.pid); // live lock (current process)
		const deps = await makeDeps(workspaceRoot, indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		// Omit `path` — but the handler defaults to process.cwd(), which is NOT our
		// temp workspace. So explicitly pass path === workspaceRoot to exercise the
		// workspace-path branch deterministically.
		const result = await tools.get("index_codebase")!.handler({
			path: workspaceRoot,
		});
		const json = parse(result);

		expect(json.status).toBe("indexing_in_progress");
		expect(result.isError).toBeUndefined();
		expect(indexCalled).toBe(false); // did NOT run the indexer
		// Did not produce the success markdown.
		expect(result.content[0].text).not.toContain("Indexing Complete");
	});

	test("A6 race: index() throws IndexLockError (lock appears) => structured non-error lock state", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeIndexDb(indexDir);
		// No lock at pre-check time => pre-check status is fresh/stale, falls through.
		const deps = await makeDeps(workspaceRoot, indexDir);

		// The mocked index() simulates the race: a lock is acquired by another
		// process between pre-check and index(), then index() throws IndexLockError.
		indexBehavior = async () => {
			writeLock(indexDir, process.pid); // live lock appears
			throw new IndexLockError(process.pid, 1234, "already_running");
		};

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("index_codebase")!.handler({
			path: workspaceRoot,
		});
		const json = parse(result);

		// Non-error structured shape; status reflects request-time truth.
		expect(result.isError).toBeUndefined();
		expect(["indexing_in_progress", "stale_lock"]).toContain(json.status);
		expect(indexCalled).toBe(true); // it DID attempt to index (then caught)
	});

	test("CRITICAL-1: caller path != workspace + workspace lock present => index PROCEEDS", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeIndexDb(indexDir);
		writeLock(indexDir, process.pid); // workspace A is "indexing" (live lock)

		// Caller asks to index a DIFFERENT path B.
		const otherRoot = mkdtempSync(join(tmpdir(), "index-codebase-other-"));
		tempDirs.push(otherRoot);

		const deps = await makeDeps(workspaceRoot, indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("index_codebase")!.handler({
			path: otherRoot, // != workspaceRoot
		});

		// The pre-check must be SKIPPED (workspace lock must not block path B).
		expect(indexCalled).toBe(true);
		// Success markdown produced (indexer ran to completion).
		expect(result.content[0].text).toContain("Indexing Complete");
		// And it is NOT the structured indexing_in_progress shape.
		expect(result.content[0].text).not.toContain(
			'"status":"indexing_in_progress"',
		);
	});

	test("CRITICAL-1: cross-path late IndexLockError is NOT translated (surfaces as error)", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeIndexDb(indexDir);

		const otherRoot = mkdtempSync(join(tmpdir(), "index-codebase-other2-"));
		tempDirs.push(otherRoot);

		const deps = await makeDeps(workspaceRoot, indexDir);

		// index() for path B throws its own IndexLockError. Because path != workspace,
		// the handler must NOT translate it — it surfaces via errorResponse.
		indexBehavior = async () => {
			throw new IndexLockError(99999, 100, "already_running");
		};

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("index_codebase")!.handler({
			path: otherRoot,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error:");
	});

	test("stale_lock (dead pid) at workspace falls through and indexes", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		// Intentionally NO index.db: a dead-pid lock classifies as stale_lock
		// regardless of index.db presence, and omitting it keeps getFileTracker()
		// from opening a fake sqlite file during the success-path activity record.
		writeLock(indexDir, 2_000_000_000); // dead pid => stale_lock, NOT indexing_in_progress
		const deps = await makeDeps(workspaceRoot, indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("index_codebase")!.handler({
			path: workspaceRoot,
		});

		// Pre-check only short-circuits on indexing_in_progress; stale_lock proceeds.
		expect(indexCalled).toBe(true);
		expect(result.content[0].text).toContain("Indexing Complete");
	});
});

// ===========================================================================
// get_status — legacy status tool now carries the structured state block.
// The mocked createIndexer.getStatus() returns { exists:false }, so these
// exercise the no-index branch (the user's original "Files: 0, Chunks: 0"
// symptom) and the cross-path guard.
// ===========================================================================
describe("get_status structured state", () => {
	// Append-parse: get_status returns markdown/text with a trailing JSON object.
	function lastJson(result: {
		content: Array<{ type: string; text: string }>;
	}): Record<string, unknown> | null {
		const text = result.content[0].text;
		const nl = text.lastIndexOf("\n");
		if (nl < 0) return null;
		try {
			return JSON.parse(text.slice(nl + 1));
		} catch {
			return null;
		}
	}

	test("no index at workspace => structured no_index block appended", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		// No index.db, no lock => status no_index.
		const deps = await makeDeps(workspaceRoot, indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("get_status")!.handler({});

		const text = result.content[0].text;
		expect(text).toContain("No index found");
		const state = lastJson(result);
		expect(state?.status).toBe("no_index");
		expect(state?.canReturnCachedResults).toBe(false);
	});

	test("live lock at workspace => indexing_in_progress block appended", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeLock(indexDir, process.pid); // alive => indexing_in_progress
		const deps = await makeDeps(workspaceRoot, indexDir);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("get_status")!.handler({});

		const state = lastJson(result);
		expect(state?.status).toBe("indexing_in_progress");
		expect((state?.indexing as { pidAlive?: boolean })?.pidAlive).toBe(true);
		// Read-only: the lock must still be present after get_status.
		expect(existsSync(join(indexDir, LOCK_FILENAME))).toBe(true);
	});

	test("cross-path (path != workspace) => NO structured block appended", async () => {
		const { workspaceRoot, indexDir } = makeWorkspace();
		writeLock(indexDir, process.pid); // workspace is "busy"
		const deps = await makeDeps(workspaceRoot, indexDir);

		// A different target dir — the structured block describes the SERVER
		// workspace, so it must be omitted for an unrelated path.
		const otherRoot = mkdtempSync(join(tmpdir(), "get-status-other-"));
		tempDirs.push(otherRoot);

		const { server, tools } = makeCapturingServer();
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		registerLegacyTools(server as any, deps);
		const result = await tools.get("get_status")!.handler({ path: otherRoot });

		// getStatus() is mocked to { exists:false } => "No index found", and the
		// cross-path guard means NO trailing JSON state block.
		expect(result.content[0].text).toContain("No index found");
		expect(lastJson(result)).toBeNull();
	});
});
