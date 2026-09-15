/**
 * Learning gate for the search tools.
 *
 * There is exactly ONE predicate for "is learning on?" — `isLearningEnabled`
 * in src/config.ts — and both entry points must consult it: the CLI directly,
 * the MCP search tools via `openToolSession`. It is opt-OUT: only an explicit
 * `learning: false` turns learning off.
 *
 * These tests count actual sqlite opens and actual DDL statements
 * (createDatabaseSync is module-mocked with a counting pass-through) and
 * assert:
 *   - CLI and MCP agree for every config state (the parity contract)
 *   - explicit opt-out => ZERO opens against index.db, results unchanged
 *   - enabled          => at most ONE open per search, boosts applied, recorded
 *   - the learning DDL is issued at most once per process per database
 *   - broken/absent config => enabled (fails open), never throws
 *   - the per-workspace gate cache is resettable
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGlobalConfig } from "../../../src/config.js";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import type { SearchResult } from "../../../src/types.js";

// ── Module mocks ────────────────────────────────────────────────────────────
// The real opener is captured by value BEFORE the mock is registered, so the
// counting wrapper delegates to it instead of recursing into itself.
const realCreateDatabaseSync = (await import("../../../src/core/sqlite.js"))
	.createDatabaseSync;

/** Every sqlite path opened since the last reset. */
let sqliteOpens: string[] = [];

/** Every `exec`'d SQL string since the last reset, paired with its db path. */
let sqliteExecs: Array<{ path: string; sql: string }> = [];

mock.module("../../../src/core/sqlite.js", () => ({
	createDatabaseSync: (path: string) => {
		sqliteOpens.push(path);
		const db = realCreateDatabaseSync(path);
		return {
			...db,
			exec: (sql: string) => {
				sqliteExecs.push({ path, sql });
				return db.exec(sql);
			},
		};
	},
}));

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
		// D1's flags ride on the response, so `search_code` uses `searchScoped`.
		searchScoped: async () => ({
			results: indexerResults,
			branchUnknown: false,
			branchLabel: null,
		}),
		close: async () => {},
		getStatus: async () => ({ exists: false }),
	}),
}));

// Imported AFTER the mocks so they pick up the counting sqlite opener.
const { registerSearchTools } = await import(
	"../../../src/mcp/tools/search.js"
);
const { registerLegacyTools } = await import(
	"../../../src/mcp/tools/legacy.js"
);
const { openToolSession } = await import("../../../src/mcp/tools/deps.js");
const { isLearningEnabled, resetLearningEnabledCache } = await import(
	"../../../src/config.js"
);
const { resetFeedbackSchemaCache } = await import(
	"../../../src/learning/feedback/feedback-store.js"
);
const { IndexStateManager } = await import("../../../src/mcp/state-manager.js");
const { FileTracker } = await import("../../../src/core/tracker.js");
const { createLearningSystem } = await import("../../../src/learning/index.js");
type ToolDeps = import("../../../src/mcp/tools/deps.js").ToolDeps;

/**
 * What a project config WITHOUT a `learning` key resolves to on this machine.
 *
 * The rule under test is the precedence: explicit project value > explicit
 * global value > default (enabled). `mnemex init` records the answer globally,
 * and the global config path is baked in from `homedir()` at module load, so a
 * test cannot redirect it without racing bun's shared module registry. Reading
 * the same global config the predicate reads keeps these assertions ALWAYS
 * RUNNING (nothing is skipped) while still asserting the exact rule: only an
 * explicit global `false` disables it. On CI and any default machine this is
 * `true`.
 */
const LEARNING_WHEN_KEY_ABSENT = loadGlobalConfig().learning !== false;

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
	dbPath: string;
}

/**
 * Temp project. `config` is written verbatim to `.mnemex/config.json` (null =
 * no config file at all); `withIndexDb` creates a real, schema-initialized
 * index.db so the ONLY thing that can keep it closed is the gate.
 */
function makeWorkspace(
	config: string | null,
	options: { withIndexDb?: boolean } = {},
): Workspace {
	const root = mkdtempSync(join(tmpdir(), "learning-gate-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	if (config !== null) {
		writeFileSync(join(indexDir, "config.json"), config);
	}
	const dbPath = join(indexDir, "index.db");
	if (options.withIndexDb !== false) {
		const tracker = new FileTracker(dbPath, root);
		tracker.close();
	}
	resetLearningEnabledCache();
	resetFeedbackSchemaCache();
	return { root, indexDir, dbPath };
}

/**
 * Seed enough learned state that the ranker is active AND confident enough to
 * use learned file boosts: >= minSamples (5) feedback events, and >25 weight
 * samples (confidence > 0.5, above the optimizer's blend threshold).
 */
function seedLearningData(ws: Workspace, boosts: Record<string, number>): void {
	const tracker = new FileTracker(ws.dbPath, ws.root);
	try {
		const learning = createLearningSystem(tracker.getDatabase());
		for (let i = 0; i < 5; i++) {
			learning.store.recordFeedback({
				query: `seed ${i}`,
				queryHash: `hash-${i}`,
				sessionId: `seed-session-${i}`,
				resultIds: ["chunk-a"],
				acceptedIds: ["chunk-a"],
				rejectedIds: [],
				feedbackType: "explicit",
				feedbackSource: "mcp",
				useCase: "search",
			});
		}

		const db = tracker.getDatabase();
		const now = new Date().toISOString();
		const weightStmt = db.prepare(
			"INSERT OR REPLACE INTO adaptive_weights (key, value, sample_count, last_updated) VALUES (?, ?, ?, ?)",
		);
		weightStmt.run("vector_weight", 0.7, 40, now);
		weightStmt.run("bm25_weight", 0.3, 40, now);

		const boostStmt = db.prepare(
			"INSERT OR REPLACE INTO file_boosts (file_path, boost_factor, sample_count, last_updated) VALUES (?, ?, ?, ?)",
		);
		for (const [filePath, factor] of Object.entries(boosts)) {
			boostStmt.run(filePath, factor, 5, now);
		}
	} finally {
		tracker.close();
	}
}

async function makeDeps(ws: Workspace): Promise<ToolDeps> {
	const stateManager = new IndexStateManager(
		ws.indexDir,
		resolveStoreLocation(dirname(ws.indexDir)),
	);
	await stateManager.initialize();
	// The cache is deliberately unavailable so only the semantic backend
	// (backed by the mocked indexer) contributes results.
	// biome-ignore lint/suspicious/noExplicitAny: minimal test double
	const cache: any = {
		get: async () => {
			throw new Error("cache unavailable");
		},
	};
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

/**
 * Run the `search` tool. `opens` is snapshotted immediately after the call so
 * later assertion helpers (which open the db themselves) cannot pollute it.
 */
async function runSearch(ws: Workspace): Promise<{
	payload: SearchPayload;
	opens: number;
	learningDdl: number;
}> {
	const deps = await makeDeps(ws);
	const { server, tools } = makeCapturingServer();
	// biome-ignore lint/suspicious/noExplicitAny: fake server
	registerSearchTools(server as any, deps);
	const tool = tools.get("search");
	if (!tool) throw new Error("search tool not registered");
	sqliteOpens = [];
	sqliteExecs = [];
	const result = await tool.handler({ query: "how does the store work" });
	const opens = indexDbOpens(ws);
	const learningDdl = learningDdlStatements(ws);
	return { payload: JSON.parse(result.content[0].text), opens, learningDdl };
}

/** Run the legacy `search_code` tool against a workspace. */
async function runSearchCode(
	ws: Workspace,
): Promise<{ text: string; opens: number; learningDdl: number }> {
	const deps = await makeDeps(ws);
	const { server, tools } = makeCapturingServer();
	// biome-ignore lint/suspicious/noExplicitAny: fake server
	registerLegacyTools(server as any, deps);
	const tool = tools.get("search_code");
	if (!tool) throw new Error("search_code tool not registered");
	sqliteOpens = [];
	sqliteExecs = [];
	const result = await tool.handler({
		query: "how does the store work",
		path: ws.root,
	});
	const opens = indexDbOpens(ws);
	const learningDdl = learningDdlStatements(ws);
	return { text: result.content[0].text, opens, learningDdl };
}

/**
 * Is `path` this workspace's index.db? Compared as FILES, not strings: the MCP
 * tools resolve the db through the store-location seam, which returns the
 * realpath spelling (`/private/var/…`), while `mkdtemp` hands out `/var/…` on
 * macOS (decision I-3).
 */
function isWorkspaceDb(ws: Workspace, path: string): boolean {
	if (path === ws.dbPath) return true;
	try {
		return realpathSync(path) === realpathSync(ws.dbPath);
	} catch {
		return false;
	}
}

/** sqlite opens recorded against this workspace's index.db. */
function indexDbOpens(ws: Workspace): number {
	return sqliteOpens.filter((p) => isWorkspaceDb(ws, p)).length;
}

/**
 * How many times the learning schema DDL was issued against this workspace's
 * index.db. Counts `exec`s, not tables: the 5 CREATE TABLEs and 6 CREATE
 * INDEXes go out as one statement batch, so 1 means "applied once".
 */
function learningDdlStatements(ws: Workspace): number {
	return sqliteExecs.filter(
		(e) =>
			isWorkspaceDb(ws, e.path) &&
			e.sql.includes("CREATE TABLE IF NOT EXISTS search_feedback"),
	).length;
}

/**
 * Rows recorded by the learning collector. 0 when the learning tables were
 * never created — nothing was recorded either way.
 */
function queryHistoryCount(ws: Workspace): number {
	const tracker = new FileTracker(ws.dbPath, ws.root);
	try {
		const row = tracker
			.getDatabase()
			.prepare("SELECT COUNT(*) AS c FROM query_history")
			.get() as { c: number };
		return row.c;
	} catch {
		return 0;
	} finally {
		tracker.close();
	}
}

/** Whether the learning schema (5 CREATE TABLE statements) was ever run. */
function hasLearningSchema(ws: Workspace): boolean {
	const tracker = new FileTracker(ws.dbPath, ws.root);
	try {
		const row = tracker
			.getDatabase()
			.prepare(
				"SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'search_feedback'",
			)
			.get() as { c: number };
		return row.c > 0;
	} finally {
		tracker.close();
	}
}

beforeEach(() => {
	indexerResults = fakeResults();
	sqliteOpens = [];
	sqliteExecs = [];
	resetLearningEnabledCache();
	resetFeedbackSchemaCache();
});

afterEach(() => {
	resetLearningEnabledCache();
	resetFeedbackSchemaCache();
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

// ── Gate ────────────────────────────────────────────────────────────────────

describe("isLearningEnabled", () => {
	test("explicit project opt-in is honoured", () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));
		expect(isLearningEnabled(ws.root)).toBe(true);
	});

	test("explicit project opt-out is honoured", () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));
		expect(isLearningEnabled(ws.root)).toBe(false);
	});

	test("missing config file falls back to the global default, and does not throw", () => {
		const ws = makeWorkspace(null);
		expect(isLearningEnabled(ws.root)).toBe(LEARNING_WHEN_KEY_ABSENT);
	});

	test("malformed config falls back to the global default, and does not throw", () => {
		const ws = makeWorkspace("{ this is not json");
		expect(isLearningEnabled(ws.root)).toBe(LEARNING_WHEN_KEY_ABSENT);
	});

	test("config without a learning key falls back to the global default", () => {
		const ws = makeWorkspace(JSON.stringify({ excludePatterns: [] }));
		expect(isLearningEnabled(ws.root)).toBe(LEARNING_WHEN_KEY_ABSENT);
	});

	test("an explicit project value overrides the global one, both ways", () => {
		// Deterministic regardless of what this machine's global config says:
		// an explicit project value is consulted first and wins outright.
		const off = makeWorkspace(JSON.stringify({ learning: false }));
		expect(isLearningEnabled(off.root)).toBe(false);

		const on = makeWorkspace(JSON.stringify({ learning: true }));
		expect(isLearningEnabled(on.root)).toBe(true);
	});

	test("the decision is cached per workspace until reset", () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));
		expect(isLearningEnabled(ws.root)).toBe(false);

		// Opt in on disk — the cached "off" must still win…
		writeFileSync(
			join(ws.indexDir, "config.json"),
			JSON.stringify({ learning: true }),
		);
		expect(isLearningEnabled(ws.root)).toBe(false);

		// …until the cache is dropped.
		resetLearningEnabledCache();
		expect(isLearningEnabled(ws.root)).toBe(true);
	});
});

// ── CLI / MCP parity ────────────────────────────────────────────────────────

/**
 * What the MCP search tools actually do, observed through the session they
 * open — NOT by re-calling the predicate, which would be tautological.
 */
function mcpLearningActive(projectPath: string): boolean {
	const session = openToolSession(projectPath);
	try {
		return session.learning !== null;
	} finally {
		session.close();
	}
}

describe("CLI and MCP agree on whether learning is on", () => {
	// Verified to FAIL against the diverging pre-fix code: with the MCP's own
	// opt-in predicate, the two "absent" states disagreed (CLI true, MCP false).
	test("absent learning key: same answer to both callers", () => {
		const ws = makeWorkspace(JSON.stringify({ excludePatterns: [] }));
		expect(mcpLearningActive(ws.root)).toBe(isLearningEnabled(ws.root));
		expect(isLearningEnabled(ws.root)).toBe(LEARNING_WHEN_KEY_ABSENT);
	});

	test("no config file at all: same answer to both callers", () => {
		const ws = makeWorkspace(null);
		expect(mcpLearningActive(ws.root)).toBe(isLearningEnabled(ws.root));
		expect(isLearningEnabled(ws.root)).toBe(LEARNING_WHEN_KEY_ABSENT);
	});

	test("explicit true: same answer to both callers", () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));
		expect(mcpLearningActive(ws.root)).toBe(isLearningEnabled(ws.root));
		expect(isLearningEnabled(ws.root)).toBe(true);
	});

	test("explicit false: same answer to both callers", () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));
		expect(mcpLearningActive(ws.root)).toBe(isLearningEnabled(ws.root));
		expect(isLearningEnabled(ws.root)).toBe(false);
	});

	test("project override of global: same answer to both callers", () => {
		// The project file is the only place either caller can look first, so
		// this pins the precedence for both at once.
		const off = makeWorkspace(JSON.stringify({ learning: false }));
		expect(mcpLearningActive(off.root)).toBe(false);
		expect(isLearningEnabled(off.root)).toBe(false);

		const on = makeWorkspace(JSON.stringify({ learning: true }));
		expect(mcpLearningActive(on.root)).toBe(true);
		expect(isLearningEnabled(on.root)).toBe(true);
	});
});

// ── search tool: opted out ──────────────────────────────────────────────────

describe("search tool with learning opted out", () => {
	test("performs ZERO sqlite opens against index.db", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));

		const { payload, opens, learningDdl } = await runSearch(ws);

		expect(payload.results.length).toBe(2);
		expect(opens).toBe(0);
		// Not even the learning schema DDL ran.
		expect(learningDdl).toBe(0);
		expect(hasLearningSchema(ws)).toBe(false);
	});

	test("explicit opt-out still does ZERO database work on a repeat search", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));

		const first = await runSearch(ws);
		const second = await runSearch(ws);

		expect(first.opens).toBe(0);
		expect(second.opens).toBe(0);
		expect(first.learningDdl).toBe(0);
		expect(second.learningDdl).toBe(0);
		expect(hasLearningSchema(ws)).toBe(false);
	});

	test("malformed config: search succeeds", async () => {
		const ws = makeWorkspace("}{ broken");

		const { payload } = await runSearch(ws);

		expect(payload.totalMatches).toBe(2);
	});

	test("results are byte-identical to a run with no learning path at all", async () => {
		// Baseline: no index.db exists, so no learning system can exist either —
		// this is the shape the pipeline produced before learning was wired in.
		const baselineWs = makeWorkspace(null, { withIndexDb: false });
		const baseline = await runSearch(baselineWs);

		const gatedWs = makeWorkspace(JSON.stringify({ learning: false }));
		const gated = await runSearch(gatedWs);

		expect(JSON.stringify(gated.payload.results)).toBe(
			JSON.stringify(baseline.payload.results),
		);
		expect(gated.payload.totalMatches).toBe(baseline.payload.totalMatches);
	});
});

// ── search tool: opted in ───────────────────────────────────────────────────

describe("search tool with learning opted in", () => {
	test("applies learned boosts and records the search (parity preserved)", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));
		seedLearningData(ws, { "src/bottom.ts": 5.0 });

		const { payload } = await runSearch(ws);

		// The boosted file overtakes the higher-scoring one.
		expect(payload.results.map((r) => r.file)).toEqual([
			"src/bottom.ts",
			"src/top.ts",
		]);
		// …and the search was fed back into the learning loop.
		expect(queryHistoryCount(ws)).toBe(1);
	});

	test("a single search opens the index db at most once", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));
		seedLearningData(ws, { "src/bottom.ts": 5.0 });

		const { opens } = await runSearch(ws);

		expect(opens).toBe(1);
	});

	test("the learning DDL is issued on the first search only", async () => {
		// Fresh db, nothing seeded: the very first search is what creates the
		// learning tables, and the second must find them already there.
		const ws = makeWorkspace(JSON.stringify({ learning: true }));

		const first = await runSearch(ws);
		const second = await runSearch(ws);

		expect(first.learningDdl).toBe(1);
		expect(second.learningDdl).toBe(0);
		// …and the tables really do exist, so the skip was safe.
		expect(hasLearningSchema(ws)).toBe(true);

		// Both searches still opened the db — the connection is not amortized,
		// only the DDL is.
		expect(first.opens).toBe(1);
		expect(second.opens).toBe(1);
	});

	test("forgetting the memo re-applies the DDL (a new db at the same path)", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));

		expect((await runSearch(ws)).learningDdl).toBe(1);
		expect((await runSearch(ws)).learningDdl).toBe(0);

		resetFeedbackSchemaCache();
		expect((await runSearch(ws)).learningDdl).toBe(1);
	});
});

// ── legacy search_code ──────────────────────────────────────────────────────

describe("search_code tool", () => {
	test("opted out: no learning work, activity recording still opens once", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: false }));

		const { text, opens, learningDdl } = await runSearchCode(ws);

		expect(text).toContain("src/top.ts");
		expect(text).not.toContain("Adaptive ranking applied");
		// One connection for activity recording — never a second one for learning.
		expect(opens).toBe(1);
		// Nothing was fed to the learning loop, and no learning DDL ran.
		expect(learningDdl).toBe(0);
		expect(hasLearningSchema(ws)).toBe(false);
		expect(queryHistoryCount(ws)).toBe(0);
	});

	test("opted in: boosts applied, search recorded, still one open", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));
		seedLearningData(ws, { "src/bottom.ts": 5.0 });

		const { text, opens, learningDdl } = await runSearchCode(ws);

		expect(text).toContain("Adaptive ranking applied");
		expect(text.indexOf("src/bottom.ts")).toBeLessThan(
			text.indexOf("src/top.ts"),
		);
		expect(opens).toBe(1);
		// seedLearningData already applied the schema to this database.
		expect(learningDdl).toBe(0);
		expect(queryHistoryCount(ws)).toBe(1);
	});

	test("the learning DDL is issued on the first search_code only", async () => {
		const ws = makeWorkspace(JSON.stringify({ learning: true }));

		const first = await runSearchCode(ws);
		const second = await runSearchCode(ws);

		expect(first.learningDdl).toBe(1);
		expect(second.learningDdl).toBe(0);
		expect(hasLearningSchema(ws)).toBe(true);
		expect(queryHistoryCount(ws)).toBe(2);
	});
});
