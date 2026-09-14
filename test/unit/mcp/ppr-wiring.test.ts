/**
 * Wiring of query-seeded Personalized PageRank into the `search` MCP tool.
 *
 * `PipelineOrchestrator` has always ACCEPTED a symbol-graph provider; until
 * this wiring landed, nothing constructed one, so the feature was unreachable.
 * These tests pin the four properties that make it safe to ship OFF:
 *
 *   - disabled (the default) => the graph is never fetched AND the orchestrator
 *     is constructed exactly as before (5th argument `undefined`, which the
 *     orchestrator treats as "no provider"). A feature that is off costs
 *     nothing — the same discipline as the learning gate, which opens no
 *     database when learning is off.
 *   - enabled => a provider IS passed, and it yields the cached graph manager.
 *   - graph acquisition throwing => search still succeeds, with no provider.
 *   - an unbuilt/empty graph => search still succeeds.
 *
 * ATTRIBUTION: every other consumer of `deps.cache` is switched off for these
 * runs — the symbol-graph, location and tree-sitter backends via
 * MNEMEX_PIPELINE_* env, LSP via `lspManager: null`, and `buildIndexState`
 * by giving the workspace no `.mnemex/index.db` (it only touches the cache
 * when one exists). So a non-zero `cache.get()` count can ONLY be the PPR path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import type { SearchResult } from "../../../src/types.js";

// ── Module mocks ────────────────────────────────────────────────────────────

/** Results the (mocked) indexer returns for every search. */
let indexerResults: SearchResult[] = [];

class FakeIndexLockError extends Error {}
class FakeIndexedModelUnavailableError extends Error {}

// Every named export an importer of indexer.js asks for must be here.
// `search.ts` imports IndexedModelUnavailableError, and a factory without it
// fails at link time with "Export named ... not found", before any test runs.
mock.module("../../../src/core/indexer.js", () => ({
	IndexLockError: FakeIndexLockError,
	IndexedModelUnavailableError: FakeIndexedModelUnavailableError,
	createIndexer: () => ({
		index: async () => ({
			filesIndexed: 0,
			chunksCreated: 0,
			durationMs: 1,
			errors: [],
		}),
		search: async () => indexerResults,
		close: async () => {},
		getStatus: async () => ({ exists: false }),
	}),
}));

/**
 * Pass-through spy on the orchestrator constructor.
 *
 * The real class is captured by value first and the spy subclasses it, so the
 * mock changes observability only — search behaviour is the real behaviour.
 */
const orchestratorModule = await import(
	"../../../src/retrieval/pipeline/orchestrator.js"
);
const RealOrchestrator = orchestratorModule.PipelineOrchestrator;

/** Every orchestrator construction since the last reset. */
let constructions: Array<{ graphProvider: unknown }> = [];

mock.module("../../../src/retrieval/pipeline/orchestrator.js", () => ({
	...orchestratorModule,
	PipelineOrchestrator: class SpyOrchestrator extends RealOrchestrator {
		constructor(...args: ConstructorParameters<typeof RealOrchestrator>) {
			super(...args);
			constructions.push({ graphProvider: args[4] });
		}
	},
}));

// Imported AFTER the mocks so they pick up the spies.
const { registerSearchTools } = await import(
	"../../../src/mcp/tools/search.js"
);
const { IndexStateManager } = await import("../../../src/mcp/state-manager.js");
const { FileTracker } = await import("../../../src/core/tracker.js");
const { createReferenceGraphManager } = await import(
	"../../../src/core/reference-graph.js"
);
const { resetLearningEnabledCache } = await import("../../../src/config.js");
type ToolDeps = import("../../../src/mcp/tools/deps.js").ToolDeps;
type SymbolGraphView =
	import("../../../src/retrieval/pipeline/graph-ppr.js").SymbolGraphView;

// ── Environment ─────────────────────────────────────────────────────────────

/**
 * Backends switched off so the PPR path is the only possible `cache.get()`
 * caller. `MNEMEX_PIPELINE_PPR` is listed so each test starts from the real
 * default (absent = off) regardless of the ambient environment.
 */
const PIPELINE_ENV = [
	"MNEMEX_PIPELINE_SYMBOL_GRAPH",
	"MNEMEX_PIPELINE_LOCATION",
	"MNEMEX_PIPELINE_TREE_SITTER",
	"MNEMEX_PIPELINE_LSP",
	"MNEMEX_PIPELINE_PPR",
] as const;

const savedEnv = new Map<string, string | undefined>();

// ── Fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

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

interface Workspace {
	root: string;
	indexDir: string;
}

/**
 * Temp project with NO index.db and learning explicitly off, so neither
 * `buildIndexState` nor `openToolSession` touches sqlite or the cache.
 */
function makeWorkspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "ppr-wiring-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	writeFileSync(
		join(indexDir, "config.json"),
		JSON.stringify({ learning: false }),
	);
	resetLearningEnabledCache();
	return { root, indexDir };
}

/** A `deps.cache` double that counts `get()` calls. */
function makeCache(behaviour: () => unknown): {
	// biome-ignore lint/suspicious/noExplicitAny: minimal test double
	cache: any;
	calls: () => number;
} {
	let calls = 0;
	return {
		cache: {
			get: async () => {
				calls++;
				return behaviour();
			},
		},
		calls: () => calls,
	};
}

async function makeDeps(
	ws: Workspace,
	// biome-ignore lint/suspicious/noExplicitAny: minimal test double
	cache: any,
): Promise<ToolDeps> {
	const stateManager = new IndexStateManager(
		ws.indexDir,
		resolveStoreLocation(dirname(ws.indexDir)),
	);
	await stateManager.initialize();
	return {
		cache,
		// biome-ignore lint/suspicious/noExplicitAny: real state manager
		stateManager: stateManager as any,
		// biome-ignore lint/suspicious/noExplicitAny: only these fields are read
		config: { indexDir: ws.indexDir, workspaceRoot: ws.root } as any,
		// biome-ignore lint/suspicious/noExplicitAny: logger stub
		logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
		serverStartTime: Date.now(),
		watcherActive: false,
		lspManager: null,
	};
}

function chunk(filePath: string, id: string) {
	return {
		id,
		contentHash: `${id}-hash`,
		content: `content of ${filePath}`,
		filePath,
		startLine: 1,
		endLine: 5,
		language: "typescript",
		chunkType: "function" as const,
		fileHash: `${id}-filehash`,
	};
}

function fakeResults(): SearchResult[] {
	return [
		{
			chunk: chunk("src/top.ts", "chunk-top"),
			score: 0.9,
			vectorScore: 0.9,
			keywordScore: 0.5,
		},
		{
			chunk: chunk("src/bottom.ts", "chunk-bottom"),
			score: 0.4,
			vectorScore: 0.4,
			keywordScore: 0.2,
		},
	];
}

interface SearchPayload {
	results: Array<{ file: string; score: number }>;
	totalMatches: number;
}

interface RunOutcome {
	payload: SearchPayload;
	isError: boolean;
	cacheGets: number;
	/** The 5th orchestrator argument from this run's single construction. */
	graphProvider: unknown;
	constructions: number;
}

/** Run the `search` tool against a workspace and a given cache double. */
async function runSearch(
	ws: Workspace,
	behaviour: () => unknown,
): Promise<RunOutcome> {
	const { cache, calls } = makeCache(behaviour);
	const deps = await makeDeps(ws, cache);
	const { server, tools } = makeCapturingServer();
	// biome-ignore lint/suspicious/noExplicitAny: fake server
	registerSearchTools(server as any, deps);
	const tool = tools.get("search");
	if (!tool) throw new Error("search tool not registered");
	constructions = [];
	const result = await tool.handler({ query: "how does the store work" });
	return {
		payload: JSON.parse(result.content[0].text),
		isError: result.isError === true,
		cacheGets: calls(),
		graphProvider: constructions[0]?.graphProvider,
		constructions: constructions.length,
	};
}

/** A cache double payload carrying an arbitrary graph manager. */
function cachedIndex(graphManager: unknown) {
	return {
		tracker: null,
		graphManager,
		repoMapGen: null,
		loadedAt: Date.now(),
	};
}

beforeEach(() => {
	indexerResults = fakeResults();
	constructions = [];
	savedEnv.clear();
	for (const key of PIPELINE_ENV) {
		savedEnv.set(key, process.env[key]);
	}
	process.env.MNEMEX_PIPELINE_SYMBOL_GRAPH = "false";
	process.env.MNEMEX_PIPELINE_LOCATION = "false";
	process.env.MNEMEX_PIPELINE_TREE_SITTER = "false";
	process.env.MNEMEX_PIPELINE_LSP = "false";
	delete process.env.MNEMEX_PIPELINE_PPR;
	resetLearningEnabledCache();
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	resetLearningEnabledCache();
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

// ── Disabled (the default) ──────────────────────────────────────────────────

describe("personalized PageRank disabled (default)", () => {
	test("the symbol graph is never fetched", async () => {
		const ws = makeWorkspace();

		const run = await runSearch(ws, () => {
			throw new Error("cache.get() must not be called when PPR is off");
		});

		// The cache double throws on contact, so this is belt AND braces: the
		// count proves it was not called, and a successful search proves nothing
		// swallowed a call that did happen.
		expect(run.cacheGets).toBe(0);
		expect(run.isError).toBe(false);
	});

	test("the orchestrator is constructed with no provider", async () => {
		const ws = makeWorkspace();

		const run = await runSearch(ws, () => {
			throw new Error("unreachable");
		});

		expect(run.constructions).toBe(1);
		// `undefined` is what the orchestrator's own gate tests for, so this is
		// indistinguishable from the pre-wiring 4-argument construction.
		expect(run.graphProvider).toBeUndefined();
	});

	test("results are unchanged — same order, same scores", async () => {
		const ws = makeWorkspace();

		const run = await runSearch(ws, () => {
			throw new Error("unreachable");
		});

		expect(run.payload.totalMatches).toBe(2);
		expect(run.payload.results.map((r) => r.file)).toEqual([
			"src/top.ts",
			"src/bottom.ts",
		]);
		// Straight weighted RRF over the single semantic backend — pinned as
		// literals so any drift in the fused score shows up here rather than
		// being absorbed by a formula that drifted with it.
		expect(run.payload.results[0].score).toBe(1 / 60);
		expect(run.payload.results[1].score).toBe(1 / 61);
	});

	test("an explicit MNEMEX_PIPELINE_PPR=false also fetches nothing", async () => {
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "false";

		const run = await runSearch(ws, () => {
			throw new Error("cache.get() must not be called when PPR is off");
		});

		expect(run.cacheGets).toBe(0);
		expect(run.graphProvider).toBeUndefined();
		expect(run.isError).toBe(false);
	});
});

// ── Enabled ─────────────────────────────────────────────────────────────────

describe("personalized PageRank enabled", () => {
	test("a provider IS passed, and it yields the cached graph manager", async () => {
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "true";

		const graphManager: SymbolGraphView = {
			findSymbolIdAtLocation: () => null,
			computePersonalizedPageRank: () => new Map<string, number>(),
		};

		const run = await runSearch(ws, () => cachedIndex(graphManager));

		expect(run.cacheGets).toBe(1);
		expect(typeof run.graphProvider).toBe("function");
		expect((run.graphProvider as () => unknown)()).toBe(graphManager);
		expect(run.isError).toBe(false);
	});

	test("the real ReferenceGraphManager satisfies the provider contract", async () => {
		// Not a cast: the manager the MCP cache actually hands out is passed
		// through the `SymbolGraphProvider` type and then invoked by the walk.
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "true";

		const graphDir = mkdtempSync(join(tmpdir(), "ppr-graph-"));
		tempDirs.push(graphDir);
		const tracker = new FileTracker(join(graphDir, "index.db"), graphDir);
		try {
			const graphManager = createReferenceGraphManager(tracker);

			const run = await runSearch(ws, () => cachedIndex(graphManager));

			expect(run.isError).toBe(false);
			const provider = run.graphProvider as () => SymbolGraphView;
			const graph = provider();
			expect(graph).toBe(graphManager as unknown as SymbolGraphView);
			// Both members of SymbolGraphView, invoked through the interface.
			expect(graph.findSymbolIdAtLocation("src/top.ts", 1, "anything")).toBe(
				null,
			);
			expect(graph.computePersonalizedPageRank(new Map()).size).toBe(0);
		} finally {
			tracker.close();
		}
	});

	test("an unbuilt/empty graph still returns results", async () => {
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "true";

		const graphDir = mkdtempSync(join(tmpdir(), "ppr-graph-empty-"));
		tempDirs.push(graphDir);
		// Never `buildGraph()`ed, and backed by a database with no symbols at all.
		const tracker = new FileTracker(join(graphDir, "index.db"), graphDir);
		try {
			const graphManager = createReferenceGraphManager(tracker);

			const run = await runSearch(ws, () => cachedIndex(graphManager));

			expect(run.isError).toBe(false);
			expect(run.payload.totalMatches).toBe(2);
			// No seed resolves, so the walk is inert and the fused order stands.
			expect(run.payload.results.map((r) => r.file)).toEqual([
				"src/top.ts",
				"src/bottom.ts",
			]);
		} finally {
			tracker.close();
		}
	});

	test("a graph with no resolvable seeds leaves the payload untouched", async () => {
		const ws = makeWorkspace();

		const disabled = await runSearch(ws, () => {
			throw new Error("unreachable");
		});

		process.env.MNEMEX_PIPELINE_PPR = "true";
		const graphManager: SymbolGraphView = {
			findSymbolIdAtLocation: () => null,
			computePersonalizedPageRank: () => new Map<string, number>(),
		};
		const enabled = await runSearch(ws, () => cachedIndex(graphManager));

		// The walk reaches nothing, so ranking must be identical to the run that
		// never consulted a graph at all — scores included.
		expect(JSON.stringify(enabled.payload.results)).toBe(
			JSON.stringify(disabled.payload.results),
		);
	});
});

// ── Degradation ─────────────────────────────────────────────────────────────

describe("personalized PageRank enabled but the graph is unavailable", () => {
	test("cache.get() throwing => search succeeds with no provider", async () => {
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "true";

		const run = await runSearch(ws, () => {
			throw new Error("No index found. Run 'mnemex index' first.");
		});

		expect(run.cacheGets).toBe(1);
		expect(run.isError).toBe(false);
		expect(run.graphProvider).toBeUndefined();
		expect(run.payload.totalMatches).toBe(2);
		expect(run.payload.results.map((r) => r.file)).toEqual([
			"src/top.ts",
			"src/bottom.ts",
		]);
	});

	test("a rejected cache promise degrades the same way", async () => {
		// The synchronous-throw and async-rejection paths are different catch
		// sites; both must land on "no provider".
		const ws = makeWorkspace();
		process.env.MNEMEX_PIPELINE_PPR = "true";

		const run = await runSearch(ws, () =>
			Promise.reject(new Error("index db is locked")),
		);

		expect(run.cacheGets).toBe(1);
		expect(run.isError).toBe(false);
		expect(run.graphProvider).toBeUndefined();
		expect(run.payload.totalMatches).toBe(2);
	});
});
