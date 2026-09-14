/**
 * Decision I-8 / FR-3: a lock and the data it protects resolve from ONE function.
 *
 * The store lock derived its path from the seam (`resolveStoreLocation` ->
 * `getLockPathFor`), which honours `MNEMEX_INDEX_DIR`. The data paths came from
 * `src/config.ts`'s `getIndexDir`, which did not, and from three resolvers that
 * hardcoded `<project>/.mnemex`. Two processes that disagreed about the variable
 * therefore wrote ONE store under TWO locks. Every resolver now delegates to the
 * seam; this file proves it three ways:
 *
 *   1. THE FR-3 SWEEP (paths). For every precedence row, every entry point's
 *      resolver names the lock's directory: the config helpers the indexer, the
 *      CLI and the observe writer call, and the MCP server's `indexDir`, which
 *      the state manager, the completion detector, the reindexer and
 *      `index_status` consume. Also through a second SPELLING of the project
 *      (a symlink), because the seam canonicalises and callers do not.
 *
 *   2. CO-LOCATION ON DISK. The writers run for real, and the bytes are found
 *      in the directory the TEST computed, never through the resolver under
 *      test: ensureProjectDir's CACHEDIR.TAG, a tracker row written through the
 *      MCP `getFileTracker` and counted over an independent SQLite connection,
 *      an observation row counted over an independent LanceDB connection, the
 *      state manager's timestamp, and the lock file itself, which the MCP
 *      reindexer and `index_status` must both see.
 *
 *   3. STATIC. No file in `src/` joins a store file name itself (outside a
 *      reasoned, exact list), and none but the seam reads MNEMEX_INDEX_DIR.
 *
 *   4. STATIC, ON THE AST. No file in `src/` builds `<.mnemex dir>/<store
 *      artifact>` in any spelling the check can follow, and every file that
 *      mints a bare `.mnemex` directory is classified. Added after the TUI was
 *      found opening `<project>/.mnemex/index.db` by hand. The block at the end
 *      of this file states what it cannot see.
 *
 * Falsified by reverting `getIndexDir` to its pre-I-8 body (recorded in the
 * session's implementation log). The DISK test goes red for exactly the three
 * MNEMEX_INDEX_DIR rows, CACHEDIR.TAG landing in `<project>/.mnemex` while the
 * lock is in the override, and stays green for the other five. The SWEEP goes
 * red for those three on the direct check, and for four more on the symlink
 * check only: the old body returned the caller's spelling, the same directory
 * under another name, which is a resolver bypassing the seam without an
 * override set. The CLI entry points are proven on disk by
 * `test/e2e/store-override-colocation-e2e.test.ts`.
 *
 * Expected directories are computed from the sandbox root, which is already
 * realpath-resolved, so they carry the seam's spelling (decision I-3).
 */

import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Node, Parser } from "web-tree-sitter";
import {
	ensureProjectDir,
	getDocsCachePath,
	getIndexDbPath,
	getIndexDir,
	getVectorStorePath,
} from "../../../src/config.js";
import { createStoreLock } from "../../../src/core/lock.js";
import { appendObservation } from "../../../src/core/observation-writer.js";
import {
	__resetStoreLocationCacheForTests,
	getLockPathFor,
	INDEX_DIR_ENV_VAR,
	resolveStoreLocation,
	type StoreKind,
	type StoreLocation,
} from "../../../src/core/store-location.js";
import { createFileTracker } from "../../../src/core/tracker.js";
import { loadMcpConfig, type McpConfig } from "../../../src/mcp/config.js";
import { buildIndexState } from "../../../src/mcp/index-state.js";
import { DebounceReindexer } from "../../../src/mcp/reindexer.js";
import { IndexStateManager } from "../../../src/mcp/state-manager.js";
import { getFileTracker, type ToolDeps } from "../../../src/mcp/tools/deps.js";
import { getParserManager } from "../../../src/parsers/parser-manager.js";
import type { DocumentWithEmbedding } from "../../../src/types.js";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** What a store directory holds, per §2.4. None of it may appear in the wrong one. */
const STORE_ARTIFACTS = [
	"index.db",
	"vectors",
	".indexing.lock",
	"CACHEDIR.TAG",
	".reindex-timestamp",
];

let sb: GitSandbox;
let counter = 0;
const savedEnv = process.env[INDEX_DIR_ENV_VAR];

beforeAll(() => {
	sb = createGitSandbox("one-resolver-");
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[INDEX_DIR_ENV_VAR];
	else process.env[INDEX_DIR_ENV_VAR] = savedEnv;
	__resetStoreLocationCacheForTests();
});

afterAll(() => {
	sb?.cleanup();
});

function makeProject(git: boolean): string {
	const dir = join(sb.root, `project-${++counter}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
	if (git) sb.git(dir, "init", "-q");
	return dir;
}

/** A store path that does not exist yet: the first writer must create it. */
function freshStorePath(): string {
	return join(sb.root, `store-${++counter}`);
}

function writeProjectConfig(project: string, indexDir: string): void {
	writeFileSync(join(project, "mnemex.json"), JSON.stringify({ indexDir }));
}

interface Arranged {
	project: string;
	/** Computed by the TEST, from the sandbox root. Never from the seam. */
	expected: string;
	kind: StoreKind;
}

interface Scenario {
	name: string;
	arrange(): Arranged;
}

/** Every row of §2.3's precedence that Phase 2 can reach (row 3 is gated). */
const SCENARIOS: Scenario[] = [
	{
		name: "no override, inside a repository",
		arrange: () => {
			const project = makeProject(true);
			return {
				project,
				expected: join(project, ".mnemex"),
				kind: "worktree-local",
			};
		},
	},
	{
		name: "no override, a plain directory (FR-7)",
		arrange: () => {
			const project = makeProject(false);
			return {
				project,
				expected: join(project, ".mnemex"),
				kind: "plain-directory",
			};
		},
	},
	{
		name: "MNEMEX_INDEX_DIR absolute",
		arrange: () => {
			const project = makeProject(true);
			const store = freshStorePath();
			process.env[INDEX_DIR_ENV_VAR] = store;
			return { project, expected: store, kind: "env-override" };
		},
	},
	{
		name: "MNEMEX_INDEX_DIR relative (to the worktree root)",
		arrange: () => {
			const project = makeProject(true);
			process.env[INDEX_DIR_ENV_VAR] = "rel-store";
			return {
				project,
				expected: join(project, "rel-store"),
				kind: "env-override",
			};
		},
	},
	{
		name: "ProjectConfig.indexDir absolute",
		arrange: () => {
			const project = makeProject(true);
			const store = freshStorePath();
			writeProjectConfig(project, store);
			return { project, expected: store, kind: "config-override" };
		},
	},
	{
		name: "ProjectConfig.indexDir relative",
		arrange: () => {
			const project = makeProject(true);
			writeProjectConfig(project, "cfg-store");
			return {
				project,
				expected: join(project, "cfg-store"),
				kind: "config-override",
			};
		},
	},
	{
		name: 'ProjectConfig.indexDir = ".mnemex", the legacy default (D2: unset)',
		arrange: () => {
			const project = makeProject(true);
			writeProjectConfig(project, ".mnemex");
			return {
				project,
				expected: join(project, ".mnemex"),
				kind: "worktree-local",
			};
		},
	},
	{
		name: "both set: MNEMEX_INDEX_DIR outranks ProjectConfig.indexDir",
		arrange: () => {
			const project = makeProject(true);
			writeProjectConfig(project, join(project, "outranked"));
			const store = freshStorePath();
			process.env[INDEX_DIR_ENV_VAR] = store;
			return { project, expected: store, kind: "env-override" };
		},
	},
];

/**
 * The directory every entry point's resolver names, keyed by who uses it.
 * The keys say which callers go through each resolver (read from the source);
 * the CLI callers are also proven on disk by the e2e suite.
 */
function resolveEveryEntryPoint(project: string): Record<string, string> {
	const loc = resolveStoreLocation(project);
	return {
		"store lock (createStoreLock): index, observe, docs, MCP reindexer":
			dirname(createStoreLock(loc).path),
		"getIndexDir: ensureProjectDir, the rg probe": getIndexDir(project),
		"getIndexDbPath: indexer, CLI docs + tracker commands, MCP cache/server/getFileTracker":
			dirname(getIndexDbPath(project)),
		"getVectorStorePath: indexer, observe, docs fetch/clear, autocomplete":
			dirname(getVectorStorePath(project)),
		"getDocsCachePath: docs cache": dirname(getDocsCachePath(project)),
		"loadMcpConfig().indexDir: state manager, completion detector, reindexer, index_status":
			loadMcpConfig(project).indexDir,
	};
}

function countSqlRows(dbPath: string, table: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return (
			db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

async function lanceRows(vectorsDir: string, where: string): Promise<number> {
	if (!existsSync(vectorsDir)) return 0;
	const db = await lancedb.connect(vectorsDir);
	try {
		if (!(await db.tableNames()).includes("code_chunks")) return 0;
		const table = await db.openTable("code_chunks");
		try {
			return await table.countRows(where);
		} finally {
			table.close();
		}
	} finally {
		db.close();
	}
}

function observation(label: string): DocumentWithEmbedding {
	const now = new Date().toISOString();
	return {
		id: `obs-${label}`,
		content: `one resolver, one store (${label})`,
		documentType: "session_observation",
		filePath: "alpha.ts",
		fileHash: "",
		createdAt: now,
		enrichedAt: now,
		sourceIds: [],
		metadata: { observationType: "architecture", confidence: 0.9 },
		vector: Array.from({ length: 8 }, (_, i) => (i + 1) / 10),
	};
}

/** The minimum `buildIndexState` reads: config, state manager, cache stats. */
function statusDeps(
	config: McpConfig,
	stateManager: IndexStateManager,
): ToolDeps {
	const cache = {
		get: async () => ({
			tracker: { getStats: () => ({ totalFiles: 1, lastIndexed: null }) },
		}),
	};
	return {
		cache: cache as never,
		stateManager,
		config,
		logger: {} as never,
		serverStartTime: Date.now(),
		watcherActive: false,
	};
}

// ════════════════════════════════════════════════════════════════════════════
describe("FR-3 sweep: every entry point resolves ONE store directory, the lock's", () => {
	for (const scenario of SCENARIOS) {
		test(scenario.name, () => {
			const { project, expected, kind } = scenario.arrange();
			const loc = resolveStoreLocation(project);
			expect(loc.kind).toBe(kind);
			const lockDir = dirname(getLockPathFor(loc));
			expect(lockDir).toBe(expected);

			for (const [who, dir] of Object.entries(
				resolveEveryEntryPoint(project),
			)) {
				expect({ who, dir }).toEqual({ who, dir: lockDir });
			}

			// A second spelling of the same project resolves the same store: the
			// seam canonicalises, and every resolver now goes through it.
			const link = join(sb.root, `link-${++counter}`);
			symlinkSync(project, link);
			for (const [who, dir] of Object.entries(resolveEveryEntryPoint(link))) {
				expect({ who, via: "symlink", dir }).toEqual({
					who,
					via: "symlink",
					dir: lockDir,
				});
			}
		});
	}
});

// ════════════════════════════════════════════════════════════════════════════
describe("co-location on disk: every writer lands in the lock's directory", () => {
	for (const scenario of SCENARIOS) {
		test(scenario.name, async () => {
			const { project, expected } = scenario.arrange();
			const loc = resolveStoreLocation(project);
			expect(dirname(getLockPathFor(loc))).toBe(expected);

			// The indexer's first act.
			ensureProjectDir(project);
			expect(existsSync(join(expected, "CACHEDIR.TAG"))).toBe(true);

			// The database is created where the TEST expects it, not through the
			// resolver under test; the MCP tracker helper must find it and write
			// into it. Counted over an independent connection.
			const expectedDb = join(expected, "index.db");
			createFileTracker(expectedDb, project).close();
			const tracker = getFileTracker(project);
			expect(tracker).not.toBeNull();
			try {
				tracker?.markDocsIndexed("left-pad", null, "llms_txt", "h", ["c1"]);
			} finally {
				tracker?.close();
			}
			expect(countSqlRows(expectedDb, "indexed_docs")).toBe(1);

			// observe (CLI and MCP share this writer), under the store lock.
			expect(
				await appendObservation(project, observation(scenario.name)),
			).toEqual({ recorded: true });
			expect(
				await lanceRows(
					join(expected, "vectors"),
					"documentType = 'session_observation'",
				),
			).toBe(1);

			// The MCP state manager's timestamp.
			const config = loadMcpConfig(project);
			const stateManager = new IndexStateManager(config.indexDir, loc);
			stateManager.onReindexComplete();
			expect(existsSync(join(expected, ".reindex-timestamp"))).toBe(true);

			// The lock itself: the file appears in the expected directory, and the
			// MCP reindexer and `index_status` both see it as held.
			const lock = createStoreLock(loc);
			const acquired = await lock.acquire({ waitTimeout: 0 });
			try {
				expect(acquired.acquired).toBe(true);
				expect(existsSync(join(expected, ".indexing.lock"))).toBe(true);
				const reindexer = new DebounceReindexer(
					project,
					config.indexDir,
					60_000,
					stateManager,
					{} as never,
					{} as never,
					{} as never,
					() => {
						throw new Error("this test launches nothing");
					},
				);
				expect(reindexer.isLocked()).toBe(true);
				const state = await buildIndexState(
					statusDeps(config, stateManager),
					Date.now(),
				);
				expect(state.status).toBe("indexing_in_progress");
				expect(state.canReturnCachedResults).toBe(true);
			} finally {
				lock.release();
			}

			// When the store is elsewhere, the default directory got none of it.
			const defaultDir = join(project, ".mnemex");
			if (expected !== defaultDir) {
				const leaked = STORE_ARTIFACTS.filter((f) =>
					existsSync(join(defaultDir, f)),
				);
				expect(leaked).toEqual([]);
			}
		});
	}
});

// ════════════════════════════════════════════════════════════════════════════
describe("MCP memories do not move with the store (memoryDirFor)", () => {
	test("no override: <workspace>/.mnemex, the store's own directory", () => {
		const project = makeProject(true);
		const config = loadMcpConfig(project);
		expect(config.memoryDir).toBe(join(project, ".mnemex"));
		expect(config.indexDir).toBe(join(project, ".mnemex"));
	});

	test("MNEMEX_INDEX_DIR: memories follow the variable, as they always did, to where it NAMES", () => {
		const project = makeProject(true);
		const store = freshStorePath();
		process.env[INDEX_DIR_ENV_VAR] = store;
		const config = loadMcpConfig(project);
		expect(config.memoryDir).toBe(store);
		// The old resolver double-joined an absolute value onto the workspace.
		expect(config.indexDir).toBe(store);
		expect(config.indexDir).not.toBe(join(project, store));
	});

	test("ProjectConfig.indexDir: the store moves, memories stay in <workspace>/.mnemex", () => {
		const project = makeProject(true);
		const store = freshStorePath();
		writeProjectConfig(project, store);
		const config = loadMcpConfig(project);
		expect(config.indexDir).toBe(store);
		expect(config.memoryDir).toBe(join(project, ".mnemex"));
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Static: no second copy of a path rule, and no second reader of the variable
// ════════════════════════════════════════════════════════════════════════════

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFilesUnder(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** The seam and the leaf it reads names from: the only files that own store file names. */
const PATH_RULE_OWNERS = new Set([
	"src/core/store-location.ts",
	"src/core/project-config.ts",
]);

/**
 * Files that still join a store file name themselves, each with its reason. The
 * list is EXACT in both directions: a new offender fails, and so does fixing
 * one of these without deleting its entry.
 */
const STORE_PATH_RESIDUALS: Record<string, string> = {
	"src/hooks/handlers/pre-tool-use.ts":
		"Claude Code hook probe on <cwd>/.mnemex. Not owned by I-8; owed to 3c (architecture §9).",
	"src/hooks/handlers/session-start.ts":
		"Claude Code hook probe on <cwd>/.mnemex. Not owned by I-8; owed to 3c (architecture §9).",
	"src/hooks/handlers/interaction-logger.ts":
		"Claude Code hook writer on <cwd>/.mnemex. Not owned by I-8; owed to 3c (architecture §9).",
	"src/benchmark/evaluators/test-case-selector.ts":
		"Benchmark evaluator. Not owned by I-8; owed to 3c (architecture §9).",
	"src/cloud/overlay.ts":
		"The cloud overlay's OWN scratch LanceDB under <worktree>/.mnemex/overlay (§2.4), not the index store.",
	"src/mcp/completion-detector.ts":
		"Joins the seam's INDEX_DB_FILE onto the injected McpConfig.indexDir, which IS the seam's storeDir.",
};

/** A `join(...)` call, one level of nested parentheses allowed (`process.cwd()`). */
const JOIN_CALL = /\bjoin\s*\(((?:[^()]|\([^()]*\))*)\)/g;
/** A store file or directory name, as a literal or as the seam's constant. */
const STORE_FILE_NAME =
	/["'](?:index\.db|vectors|docs-cache|\.indexing\.lock|branches\.json|store\.json)["']|\b(?:INDEX_DB_FILE|VECTORS_DIR)\b/;

function joinsStoreFileName(source: string): boolean {
	for (const match of stripComments(source).matchAll(JOIN_CALL)) {
		if (STORE_FILE_NAME.test(match[1] ?? "")) return true;
	}
	return false;
}

/** Row 1 of the precedence, by name or through the seam's exported constant. */
const INDEX_DIR_ENV_READ = /\bMNEMEX_INDEX_DIR\b|\bINDEX_DIR_ENV_VAR\b/;

function srcFiles(): string[] {
	return tsFilesUnder(join(REPO_ROOT, "src")).map((f) =>
		relative(REPO_ROOT, f),
	);
}

describe("static: ONE copy of each path rule, ONE reader of MNEMEX_INDEX_DIR", () => {
	test("no file in src/ joins a store file name, outside the seam and the exact residual list", () => {
		// Falsified by: restoring any of the pre-I-8 resolvers, e.g.
		// `join(projectPath, ".mnemex", "index.db")` in src/mcp/tools/deps.ts.
		const offenders = srcFiles()
			.filter((f) => !PATH_RULE_OWNERS.has(f))
			.filter((f) =>
				joinsStoreFileName(readFileSync(join(REPO_ROOT, f), "utf8")),
			)
			.sort();
		expect(offenders).toEqual(Object.keys(STORE_PATH_RESIDUALS).sort());
	});

	test("no file in src/ but the seam names MNEMEX_INDEX_DIR in code", () => {
		// Falsified by: restoring src/mcp/config.ts's `process.env.MNEMEX_INDEX_DIR`.
		const offenders = srcFiles()
			.filter((f) => f !== "src/core/store-location.ts")
			.filter((f) =>
				INDEX_DIR_ENV_READ.test(
					stripComments(readFileSync(join(REPO_ROOT, f), "utf8")),
				),
			);
		expect(offenders).toEqual([]);
	});

	test("guarding the guards: each detector fires on the shapes it exists to catch, and not on prose", () => {
		const joins = [
			'const dbPath = join(projectPath, ".mnemex", "index.db");',
			'const d = join(projectPath, ".mnemex");\nconst db = join(d, "index.db");',
			'const p = join(process.cwd(), ".mnemex", "index.db");',
			"return join(getIndexDir(projectPath), INDEX_DB_FILE);",
			'join(\n\tgetIndexDir(projectPath),\n\t"docs-cache",\n)',
			'join(root, "vectors")',
		];
		expect(joins.filter((s) => !joinsStoreFileName(s))).toEqual([]);
		expect(
			joinsStoreFileName(
				'// join(p, ".mnemex", "index.db")\nconst x = getIndexDbPathFor(loc);\no(dim("vectors"));',
			),
		).toBe(false);

		const reads = [
			"const v = process.env.MNEMEX_INDEX_DIR;",
			'const v = process.env["MNEMEX_INDEX_DIR"];',
			"const v = process.env[INDEX_DIR_ENV_VAR];",
		];
		expect(
			reads.filter((s) => !INDEX_DIR_ENV_READ.test(stripComments(s))),
		).toEqual([]);
		expect(
			INDEX_DIR_ENV_READ.test(
				stripComments("/** honours MNEMEX_INDEX_DIR */\n// MNEMEX_INDEX_DIR\n"),
			),
		).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Static, on the AST: no `<a .mnemex directory>/<store artifact>`, in any spelling
// ════════════════════════════════════════════════════════════════════════════
//
// WHY A SECOND STATIC CHECK. The sweep above flags a `join(...)` that names a
// store file, so it saw the TUI's `join(dbDir, "index.db")` from the start. An
// allowlist entry silenced it; it was not missed. What that regex cannot see is
// every other spelling of the same bypass: `${p}/.mnemex/index.db` in a template,
// `p + "/.mnemex/vectors"`, a `.mnemex` directory held in a field or returned
// by a helper, or `loc.worktreeDir` (the seam's PER-WORKTREE directory) joined
// with a store file. Each of those binds a reader to `<project>/.mnemex`
// whatever MNEMEX_INDEX_DIR and ProjectConfig.indexDir say.
//
// THE RULE. Parse every file in src/ with the repository's own tree-sitter
// grammars (as test/helpers/launch-capability-graph.ts does), reduce each path
// expression to its segments, and flag a `.mnemex` directory segment followed
// IMMEDIATELY by a store artifact. A path that continues into another
// directory (`.mnemex/overlay/vectors`, the cloud overlay's own scratch store)
// is not the store, and does not fire.
//
//   path expressions  join/resolve (bare, or on path/posix/win32), `+` chains,
//                     template and string literals, `[..].join("/")`. Nested
//                     ones are flattened; adjacent literals are glued, so
//                     ".mne" + "mex" is `.mnemex`.
//   a .mnemex dir     the literal segment; any `x.worktreeDir`; a const
//                     exported anywhere in src/ that holds one
//                     (PROJECT_CONFIG_DIR, GLOBAL_CONFIG_DIR, ...); and, to a
//                     fixed point, every local binding, default parameter,
//                     `this.` field or assigned member whose value MAY be one
//                     (both arms of `??`, `||` and `?:`), and every function,
//                     method or arrow whose `return` may be one (exported
//                     functions across files).
//   a store artifact  every name the seam's `get*PathFor` helpers put under
//                     storeDir, DERIVED by calling them, so a new helper widens
//                     the check by itself; index.db's SQLite sidecars; and any
//                     const holding one of those names.
//
// LIMITS: what it cannot see, stated so nobody mistakes it for a proof.
//   1. PARAMETERS ARE NOT FOLLOWED. `openAt(join(p, ".mnemex"))` into a
//      `function openAt(dir) { join(dir, "index.db") }` passes, because
//      nothing is summarised across a call. The MINTING INVENTORY below bounds
//      this: the place such a directory is created is pinned and reasoned.
//   2. NAMES, NOT BINDINGS. A name is matched by its text. An aliased import
//      (`import { PROJECT_CONFIG_DIR as D }`) or a renaming re-export escapes.
//      An unrelated identifier with a tainted name is tainted too, which fails
//      loudly rather than silently.
//   3. ONLY THE SHAPES LISTED. Object-literal properties, destructuring,
//      `Array.join` with anything but "/", `path.format`, `new URL`,
//      `String.concat`, and a path assembled in a loop are not seen.
//   4. RUNTIME VALUES. A directory name read from config, the environment or
//      a file cannot be seen by any static check.
//   5. src/ ONLY. scripts/ and the test roots are not scanned.

type PathAtom =
	| { kind: "lit"; text: string }
	| { kind: "expr"; node: Node }
	| { kind: "opaque" };

type ConcatPart = { text: string } | { node: Node };

interface Taint {
	/** Identifier and member texts that may hold a `.mnemex` directory. */
	dirNames: Set<string>;
	/** Callee texts that may return one. */
	dirFunctions: Set<string>;
	/** Identifier and member texts that hold a store artifact's name. */
	artifactNames: Set<string>;
	/** Literal store artifact names (derived from the seam). */
	artifacts: ReadonlySet<string>;
	/** `x.worktreeDir` is `<pathRoot>/.mnemex` by the seam's definition. */
	worktreeDirIsMnemex: boolean;
}

interface ScannedFile {
	rel: string;
	source: string;
}

interface StorePathScan {
	/** file -> "line: code" of each hand-built `<.mnemex dir>/<store artifact>`. */
	violations: Map<string, string[]>;
	/** file -> "line: code" of each expression that mints a bare `.mnemex` directory. */
	mintings: Map<string, string[]>;
}

const MNEMEX_DIR_NAME = ".mnemex";
const PATH_MODULE = /^(?:path|posix|win32|path\.posix|path\.win32)$/;
const TRANSPARENT_WRAPPERS = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
]);
const FUNCTION_VALUES = new Set([
	"arrow_function",
	"function_expression",
	"function",
	"generator_function",
]);
const DECLARATIONS = [
	"variable_declarator",
	"assignment_expression",
	"public_field_definition",
	"required_parameter",
	"optional_parameter",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
];
const CANDIDATES = [
	"call_expression",
	"string",
	"template_string",
	"binary_expression",
];

/** Named children, without the `comment` nodes tree-sitter keeps as extras. */
function kids(node: Node | null | undefined): Node[] {
	return (node?.namedChildren ?? []).filter(
		(c): c is Node => c !== null && c.type !== "comment",
	);
}

function descendants(node: Node, types: string[]): Node[] {
	return node.descendantsOfType(types).filter((c): c is Node => c !== null);
}

function unwrap(node: Node): Node {
	let current = node;
	while (TRANSPARENT_WRAPPERS.has(current.type)) {
		const inner = kids(current)[0];
		if (inner === undefined) break;
		current = inner;
	}
	return current;
}

function operatorOf(node: Node): string | undefined {
	return node.childForFieldName("operator")?.text;
}

function isConcat(node: Node): boolean {
	return node.type === "binary_expression" && operatorOf(node) === "+";
}

function stringValue(node: Node): string {
	return kids(node)
		.map((c) => c.text)
		.join("");
}

/** `join(...)` / `resolve(...)`, bare or on the path module. Not `Promise.resolve`, not `parts.join`. */
function isPathCall(node: Node): boolean {
	if (node.type !== "call_expression") return false;
	const fn = node.childForFieldName("function");
	if (fn?.type === "identifier") {
		return fn.text === "join" || fn.text === "resolve";
	}
	if (fn?.type !== "member_expression") return false;
	const property = fn.childForFieldName("property")?.text;
	return (
		(property === "join" || property === "resolve") &&
		PATH_MODULE.test(fn.childForFieldName("object")?.text ?? "")
	);
}

/** The elements of `[a, b, c].join("/")`, or null for any other call. */
function slashJoinedElements(node: Node): Node[] | null {
	if (node.type !== "call_expression") return null;
	const fn = node.childForFieldName("function");
	if (
		fn?.type !== "member_expression" ||
		fn.childForFieldName("property")?.text !== "join"
	) {
		return null;
	}
	const array = fn.childForFieldName("object");
	const [separator, ...rest] = kids(node.childForFieldName("arguments"));
	if (
		array?.type !== "array" ||
		rest.length > 0 ||
		separator?.type !== "string" ||
		stringValue(separator) !== "/"
	) {
		return null;
	}
	return kids(array);
}

/** A `+` chain, template or string, as the literal text and expressions it concatenates. */
function concatParts(node: Node): ConcatPart[] {
	const n = unwrap(node);
	if (n.type === "string") return [{ text: stringValue(n) }];
	if (n.type === "template_string") {
		return kids(n).flatMap((c): ConcatPart[] => {
			if (c.type !== "template_substitution") return [{ text: c.text }];
			const inner = kids(c)[0];
			return inner === undefined ? [] : concatParts(inner);
		});
	}
	if (isConcat(n)) {
		const left = n.childForFieldName("left");
		const right = n.childForFieldName("right");
		return [
			...(left ? concatParts(left) : []),
			...(right ? concatParts(right) : []),
		];
	}
	return [{ node: n }];
}

/** Cut concatenated parts at `/` (or `\`) into path segments. */
function segments(parts: ConcatPart[]): PathAtom[] {
	const atoms: PathAtom[] = [];
	let current: ConcatPart[] = [];
	const flush = (): void => {
		const nodes = current.flatMap((p) => ("node" in p ? [p.node] : []));
		const text = current.map((p) => ("text" in p ? p.text : "")).join("");
		const [only] = nodes;
		if (nodes.length === 0) {
			if (text !== "" && text !== ".") atoms.push({ kind: "lit", text });
		} else if (nodes.length === 1 && text === "" && only !== undefined) {
			atoms.push(...pathAtoms(only));
		} else {
			// `${dir}.db`: an expression glued to text is neither a directory nor a name.
			atoms.push({ kind: "opaque" });
		}
		current = [];
	};
	for (const part of parts) {
		if ("node" in part) {
			current.push(part);
			continue;
		}
		const pieces = part.text.split(/[\\/]+/);
		for (let i = 0; i < pieces.length; i++) {
			if (i > 0) flush();
			const piece = pieces[i];
			if (piece) current.push({ text: piece });
		}
	}
	flush();
	return atoms;
}

/** The segments a path expression composes; anything else is one expression atom. */
function pathAtoms(node: Node): PathAtom[] {
	const n = unwrap(node);
	if (isPathCall(n)) {
		return kids(n.childForFieldName("arguments")).flatMap((arg): PathAtom[] =>
			arg.type === "spread_element"
				? [{ kind: "opaque" }]
				: segments(concatParts(arg)),
		);
	}
	const elements = slashJoinedElements(n);
	if (elements !== null) {
		return elements.flatMap((e) => segments(concatParts(e)));
	}
	if (n.type === "string" || n.type === "template_string" || isConcat(n)) {
		return segments(concatParts(n));
	}
	return [{ kind: "expr", node: n }];
}

/** Every value a `?:`, `??` or `||` can produce. */
function alternatives(node: Node): Node[] {
	const n = unwrap(node);
	const op = n.type === "binary_expression" ? operatorOf(n) : undefined;
	const arms =
		n.type === "ternary_expression"
			? [n.childForFieldName("consequence"), n.childForFieldName("alternative")]
			: op === "??" || op === "||"
				? [n.childForFieldName("left"), n.childForFieldName("right")]
				: null;
	if (arms === null) return [n];
	return arms.filter((a): a is Node => a !== null).flatMap(alternatives);
}

function isDirLeaf(node: Node, t: Taint): boolean {
	if (node.type === "identifier") return t.dirNames.has(node.text);
	if (node.type === "member_expression") {
		const property = node.childForFieldName("property")?.text;
		return (
			(t.worktreeDirIsMnemex && property === "worktreeDir") ||
			t.dirNames.has(node.text)
		);
	}
	if (node.type === "call_expression") {
		const fn = node.childForFieldName("function");
		return fn !== null && t.dirFunctions.has(unwrap(fn).text);
	}
	return false;
}

/** May this expression evaluate to a `.mnemex` directory? */
function mayBeDir(node: Node, t: Taint): boolean {
	return alternatives(node).some((alt) => {
		const last = pathAtoms(alt).at(-1);
		if (last === undefined || last.kind === "opaque") return false;
		if (last.kind === "lit") return last.text === MNEMEX_DIR_NAME;
		const leaf = unwrap(last.node);
		return alternatives(leaf).length > 1
			? mayBeDir(leaf, t)
			: isDirLeaf(leaf, t);
	});
}

function isDirAtom(atom: PathAtom, t: Taint): boolean {
	if (atom.kind === "lit") return atom.text === MNEMEX_DIR_NAME;
	return atom.kind === "expr" && mayBeDir(atom.node, t);
}

function isArtifactAtom(atom: PathAtom | undefined, t: Taint): boolean {
	if (atom === undefined || atom.kind === "opaque") return false;
	if (atom.kind === "lit") return t.artifacts.has(atom.text);
	return alternatives(atom.node).some((alt) => {
		const first = pathAtoms(alt)[0];
		if (first === undefined || first.kind === "opaque") return false;
		if (first.kind === "lit") return t.artifacts.has(first.text);
		return t.artifactNames.has(unwrap(first.node).text);
	});
}

function buildsStorePathUnderMnemex(node: Node, t: Taint): boolean {
	const atoms = pathAtoms(node);
	return atoms.some(
		(atom, i) => isDirAtom(atom, t) && isArtifactAtom(atoms[i + 1], t),
	);
}

function isPathCandidate(node: Node): boolean {
	return (
		isPathCall(node) ||
		slashJoinedElements(node) !== null ||
		node.type === "string" ||
		node.type === "template_string" ||
		isConcat(node)
	);
}

/** A candidate that is a segment of an enclosing path expression is judged as part of that one. */
function isOutermostPath(node: Node): boolean {
	let parent = node.parent;
	while (parent !== null && TRANSPARENT_WRAPPERS.has(parent.type)) {
		parent = parent.parent;
	}
	if (parent === null) return true;
	if (isConcat(parent) || parent.type === "template_substitution") return false;
	const call = parent.parent;
	if (parent.type === "arguments" && call !== null && isPathCall(call)) {
		return false;
	}
	const joinCall = parent.parent?.parent;
	return !(
		parent.type === "array" &&
		joinCall !== null &&
		joinCall !== undefined &&
		slashJoinedElements(joinCall) !== null
	);
}

function returnsDir(fn: Node, t: Taint): boolean {
	const body = fn.childForFieldName("body");
	if (body === null) return false;
	if (body.type !== "statement_block") return mayBeDir(body, t);
	return descendants(body, ["return_statement"]).some((r) => {
		const value = kids(r)[0];
		return value !== undefined && mayBeDir(value, t);
	});
}

/** One declaration's contribution to the taint. */
function learn(decl: Node, t: Taint): void {
	const field = (name: string): Node | null => decl.childForFieldName(name);
	switch (decl.type) {
		case "variable_declarator": {
			const name = field("name");
			const raw = field("value");
			if (name?.type !== "identifier" || raw === null) return;
			const value = unwrap(raw);
			if (FUNCTION_VALUES.has(value.type)) {
				if (returnsDir(value, t)) t.dirFunctions.add(name.text);
				return;
			}
			if (mayBeDir(value, t)) t.dirNames.add(name.text);
			if (value.type === "string" && t.artifacts.has(stringValue(value))) {
				t.artifactNames.add(name.text);
			}
			return;
		}
		case "assignment_expression": {
			const left = field("left");
			const right = field("right");
			if (left !== null && right !== null && mayBeDir(right, t)) {
				t.dirNames.add(unwrap(left).text);
			}
			return;
		}
		case "public_field_definition": {
			const name = field("name");
			const value = field("value");
			if (name !== null && value !== null && mayBeDir(value, t)) {
				t.dirNames.add(`this.${name.text}`);
			}
			return;
		}
		case "required_parameter":
		case "optional_parameter": {
			const pattern = field("pattern");
			const value = field("value");
			if (pattern?.type === "identifier" && value !== null) {
				if (mayBeDir(value, t)) t.dirNames.add(pattern.text);
			}
			return;
		}
		case "method_definition": {
			const name = field("name");
			if (name !== null && returnsDir(decl, t)) {
				t.dirFunctions.add(`this.${name.text}`);
			}
			return;
		}
		default: {
			const name = field("name");
			if (name !== null && returnsDir(decl, t)) t.dirFunctions.add(name.text);
		}
	}
}

function taintSize(t: Taint): number {
	return t.dirNames.size + t.dirFunctions.size + t.artifactNames.size;
}

function cloneTaint(t: Taint): Taint {
	return {
		dirNames: new Set(t.dirNames),
		dirFunctions: new Set(t.dirFunctions),
		artifactNames: new Set(t.artifactNames),
		artifacts: t.artifacts,
		worktreeDirIsMnemex: t.worktreeDirIsMnemex,
	};
}

/** Grow `t` with one file's declarations until nothing new is learned. */
function saturate(decls: Node[], t: Taint): void {
	for (let round = 0; round < 32; round++) {
		const before = taintSize(t);
		for (const decl of decls) learn(decl, t);
		if (taintSize(t) === before) return;
	}
}

/** The top-level exported declarators and functions: `[name, value-or-declaration]`. */
function exportedBindings(root: Node): Array<[string, Node]> {
	const out: Array<[string, Node]> = [];
	for (const stmt of kids(root)) {
		if (stmt.type !== "export_statement") continue;
		for (const decl of kids(stmt)) {
			if (decl.type === "lexical_declaration") {
				for (const d of kids(decl)) {
					const name = d.childForFieldName("name");
					const value = d.childForFieldName("value");
					if (d.type === "variable_declarator" && name && value) {
						out.push([name.text, unwrap(value)]);
					}
				}
			} else if (decl.type === "function_declaration") {
				const name = decl.childForFieldName("name");
				if (name) out.push([name.text, decl]);
			}
		}
	}
	return out;
}

async function tsParsers(): Promise<{ ts: Parser; tsx: Parser }> {
	const manager = getParserManager();
	await manager.initialize();
	const ts = await manager.getParser("typescript");
	const tsx = await manager.getParser("tsx");
	if (!ts || !tsx) {
		throw new Error(
			"TypeScript/TSX grammars are missing: run `bun run download-grammars` (CLAUDE.md #13)",
		);
	}
	return { ts, tsx };
}

/**
 * Every name the seam's `get*PathFor` helpers put directly under `storeDir`,
 * found by CALLING each exported helper on a probe location, plus SQLite's
 * sidecars of the database. A helper added to the seam widens this by itself.
 */
async function seamStoreArtifacts(): Promise<ReadonlySet<string>> {
	const seam: Record<string, unknown> = await import(
		"../../../src/core/store-location.js"
	);
	const probe: StoreLocation = {
		storeDir: "/probe-store",
		worktreeDir: "/probe-worktree/.mnemex",
		pathRoot: "/probe-worktree",
		kind: "worktree-local",
		gitLayout: null,
		degradedReason: null,
		ignoredLegacyIndexDir: false,
		envIndexDir: undefined,
	};
	const names = new Set<string>();
	for (const [name, helper] of Object.entries(seam)) {
		if (!/^get\w+PathFor$/.test(name) || typeof helper !== "function") continue;
		const path: unknown = (helper as (loc: StoreLocation) => unknown)(probe);
		if (typeof path !== "string") continue;
		const [first] = relative(probe.storeDir, path).split(/[\\/]/);
		if (!first || first === "..") continue;
		names.add(first);
		if (name === "getIndexDbPathFor") {
			for (const sidecar of ["-wal", "-shm", "-journal"]) {
				names.add(`${first}${sidecar}`);
			}
		}
	}
	return names;
}

function emptyTaint(
	artifacts: ReadonlySet<string>,
	worktreeDirIsMnemex: boolean,
): Taint {
	return {
		dirNames: new Set(),
		dirFunctions: new Set(),
		artifactNames: new Set(),
		artifacts,
		worktreeDirIsMnemex,
	};
}

function locate(node: Node): string {
	const code = node.text.replace(/\s+/g, " ");
	return `${node.startPosition.row + 1}: ${code.length > 100 ? `${code.slice(0, 97)}...` : code}`;
}

async function scanStorePaths(
	files: ScannedFile[],
	artifacts: ReadonlySet<string>,
): Promise<StorePathScan> {
	const { ts, tsx } = await tsParsers();
	const trees = files.map((f) => {
		const tree = (f.rel.endsWith(".tsx") ? tsx : ts).parse(f.source);
		if (!tree) throw new Error(`tree-sitter could not parse ${f.rel}`);
		const root = tree.rootNode;
		return {
			rel: f.rel,
			tree,
			root,
			decls: descendants(root, DECLARATIONS),
			candidates: descendants(root, CANDIDATES).filter(
				(n) => isPathCandidate(n) && isOutermostPath(n),
			),
		};
	});
	try {
		// Exports cross files: iterate the whole tree set to a fixed point.
		const global = emptyTaint(artifacts, true);
		for (let round = 0; round < 32; round++) {
			const before = taintSize(global);
			for (const file of trees) {
				const local = cloneTaint(global);
				saturate(file.decls, local);
				for (const [name] of exportedBindings(file.root)) {
					if (local.dirNames.has(name)) global.dirNames.add(name);
					if (local.dirFunctions.has(name)) global.dirFunctions.add(name);
					if (local.artifactNames.has(name)) global.artifactNames.add(name);
				}
			}
			if (taintSize(global) === before) break;
		}

		// Minting counts PRIMITIVES only: the literal, and a const exported as
		// exactly ".mnemex". Re-using an already-minted directory is not minting.
		const primitives = emptyTaint(artifacts, false);
		for (const file of trees) {
			for (const [name, value] of exportedBindings(file.root)) {
				if (value.type === "string" && stringValue(value) === MNEMEX_DIR_NAME) {
					primitives.dirNames.add(name);
				}
			}
		}

		const scan: StorePathScan = { violations: new Map(), mintings: new Map() };
		const record = (into: Map<string, string[]>, rel: string, node: Node) => {
			const hits = into.get(rel) ?? [];
			hits.push(locate(node));
			into.set(rel, hits);
		};
		for (const file of trees) {
			const local = cloneTaint(global);
			saturate(file.decls, local);
			for (const node of file.candidates) {
				if (buildsStorePathUnderMnemex(node, local)) {
					record(scan.violations, file.rel, node);
				}
				if (mayBeDir(node, primitives)) record(scan.mintings, file.rel, node);
			}
		}
		return scan;
	} finally {
		for (const { tree } of trees) tree.delete();
	}
}

let srcScan: Promise<StorePathScan> | undefined;

function scanSrc(): Promise<StorePathScan> {
	srcScan ??= (async () =>
		scanStorePaths(
			srcFiles().map((rel) => ({
				rel,
				source: readFileSync(join(REPO_ROOT, rel), "utf8"),
			})),
			await seamStoreArtifacts(),
		))();
	return srcScan;
}

/** The seam: the one file that composes these paths, exempt from both lists. */
const SEAM_FILE = "src/core/store-location.ts";

/**
 * Files that still build `<.mnemex dir>/<store artifact>` by hand, each with
 * its reason. EXACT in both directions: a new offender fails, and so does a
 * fixed one whose entry was not deleted. Every entry is also on
 * STORE_PATH_RESIDUALS above, which sees the plain `join` form.
 */
const MNEMEX_STORE_PATH_ALLOWLIST: Record<string, string> = {
	"src/hooks/handlers/pre-tool-use.ts":
		"Claude Code hook: probes <cwd>/.mnemex/index.db. Not owned by I-8; owed to 3c (architecture §9).",
	"src/hooks/handlers/session-start.ts":
		"Claude Code hook: probes <cwd>/.mnemex/index.db. Not owned by I-8; owed to 3c (architecture §9).",
	"src/hooks/handlers/interaction-logger.ts":
		"Claude Code hook: WRITES <cwd>/.mnemex/index.db. Not owned by I-8; owed to 3c (architecture §9).",
	"src/benchmark/evaluators/test-case-selector.ts":
		"Benchmark evaluator: reads <project>/.mnemex/index.db. Not owned by I-8; owed to 3c (architecture §9).",
};

/**
 * THE MINTING INVENTORY, which bounds limit 1 above. A file that builds a
 * bare `.mnemex` directory from primitives (the literal, or a const exported
 * as exactly ".mnemex") is where a directory can start its way into a
 * parameter that the check cannot follow. Every such file is here, EXACT in
 * both directions, with what its directory is for. A new one fails until
 * someone decides whether it is the store (then use the seam) or a
 * per-worktree, machine-global or ignore-list name (then add it, with why).
 */
const MNEMEX_DIR_MINTERS: Record<string, string> = {
	"src/config.ts":
		"GLOBAL_CONFIG_DIR: the machine-global ~/.mnemex (user config, credential lock, models cache). Never a project store.",
	"src/migration.ts":
		"Renames .claudemem to .mnemex in the project and in ~, and writes it to .gitignore (CLAUDE.md Historical Artifacts).",
	"src/cli.ts":
		"`.mnemex` as a directory NAME in an ignore list. Its other .mnemex paths go on into overlay/ and benchmark*, not the store.",
	"src/core/embed-cache.ts":
		"~/.mnemex: the user directory the embed-cache path guard refuses without the entry point's consent (CLAUDE.md #31).",
	"src/updater/cache.ts": "~/.mnemex: the update-check cache. Machine-global.",
	"src/cloud/machine-id.ts": "~/.mnemex: the machine id. Machine-global.",
	"src/cloud/auth.ts": "~/.mnemex: cloud credentials. Machine-global.",
	"src/core/project-config.ts":
		"Owns PROJECT_CONFIG_DIR, and reads/writes the PER-WORKTREE <project>/.mnemex/config.json (index version lives there).",
	"src/mcp/config.ts":
		"memoryDirFor: MCP memories in <workspace>/.mnemex, deliberately NOT the store (I-8 memories decision).",
	"src/core/watcher/file-watcher.ts":
		"`.mnemex` as a directory NAME in the watcher's ignore set.",
	"src/shared/pattern-matcher.ts":
		"`.mnemex` as a directory NAME in the default ignore list.",
	"src/tui/hooks/useActivityMonitor.ts":
		"Watches <project>/.mnemex for activity.jsonl: per-worktree data (§2.4), not the store.",
	"src/hooks/handlers/pre-tool-use.ts":
		"Claude Code hook: <cwd>/.mnemex. Owed to 3c; see MNEMEX_STORE_PATH_ALLOWLIST.",
	"src/hooks/handlers/session-start.ts":
		"Claude Code hook: <cwd>/.mnemex. Owed to 3c; see MNEMEX_STORE_PATH_ALLOWLIST.",
	"src/hooks/handlers/interaction-logger.ts":
		"Claude Code hook: <cwd>/.mnemex. Owed to 3c; see MNEMEX_STORE_PATH_ALLOWLIST.",
	"src/hooks/handlers/post-tool-use.ts":
		"Claude Code hook: <cwd>/.mnemex for .reindex-timestamp and .reindex-lock. Owed to 3c (architecture §9).",
	"src/benchmark-v2/index.ts":
		"Benchmark scratch: creates <project>/.mnemex for benchmark.db and its reports. Not the store.",
};

/** Found in `found` but not listed, minus the seam. */
function unlisted(
	found: Map<string, string[]>,
	listed: Record<string, string>,
): Record<string, string[]> {
	return Object.fromEntries(
		[...found].filter(([file]) => file !== SEAM_FILE && !(file in listed)),
	);
}

/** Listed but no longer found. */
function staleEntries(
	found: Map<string, string[]>,
	listed: Record<string, string>,
): string[] {
	return Object.keys(listed)
		.filter((file) => !found.has(file))
		.sort();
}

describe("static, on the AST: no hand-built <.mnemex dir>/<store artifact> path", () => {
	test("the artifacts are DERIVED from the seam's get*PathFor helpers and cover every name §2.4 lists", async () => {
		const artifacts = await seamStoreArtifacts();
		const missing = [
			"index.db",
			"index.db-wal",
			"index.db-shm",
			"vectors",
			".indexing.lock",
			"store.json",
			"branches.json",
			"docs-cache",
		].filter((name) => !artifacts.has(name));
		expect(missing).toEqual([]);
	});

	test("no file in src/ builds one, outside the seam and the exact allowlist", async () => {
		// Falsified by: the pre-fix src/tui/context.tsx (see the implementation log).
		const scan = await scanSrc();
		expect(unlisted(scan.violations, MNEMEX_STORE_PATH_ALLOWLIST)).toEqual({});
		expect(staleEntries(scan.violations, MNEMEX_STORE_PATH_ALLOWLIST)).toEqual(
			[],
		);
	}, 60_000);

	test("every file in src/ that mints a bare .mnemex directory is classified, exactly", async () => {
		const scan = await scanSrc();
		expect(unlisted(scan.mintings, MNEMEX_DIR_MINTERS)).toEqual({});
		expect(staleEntries(scan.mintings, MNEMEX_DIR_MINTERS)).toEqual([]);
	}, 60_000);

	test("guarding the guard: it fires on every shape it claims, and on none of the look-alikes", async () => {
		const fixtures: Record<string, string> = {
			"def/project-config.ts":
				'export const PROJECT_CONFIG_DIR = ".mnemex";\nexport const INDEX_DB_FILE = "index.db";',
			"def/cross-file.ts":
				'export function dataDir(p: string) {\n\treturn join(p, ".mnemex");\n}\nexport const HOME_STORE = join(h, ".mnemex");',
			"pos/one-join.ts":
				'const dbPath = join(projectPath, ".mnemex", "index.db");',
			// The pre-fix TUI, verbatim in shape.
			"pos/tui-two-step.tsx":
				'const [tracker] = useState(() => {\n\tconst dbDir = join(projectPath, ".mnemex");\n\tif (!existsSync(dbDir)) {\n\t\tmkdirSync(dbDir, { recursive: true });\n\t}\n\tconst dbPath = join(dbDir, "index.db");\n\treturn new FileTracker(dbPath, projectPath);\n});',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture SOURCE text; the parser must see a template.
			"pos/template.ts": "const p = `${projectPath}/.mnemex/index.db`;",
			"pos/concat.ts": 'const p = projectPath + "/.mnemex/" + "vectors";',
			"pos/constants.ts":
				"const d = join(p, PROJECT_CONFIG_DIR);\nconst db = join(d, INDEX_DB_FILE);",
			"pos/split-literal.ts":
				'const d = join(p, ".mne" + "mex");\nconst lock = d + "/.indexing.lock";',
			"pos/helper-function.ts":
				'function storeDir(p: string) {\n\treturn join(p, ".mnemex");\n}\nconst b = join(storeDir(p), "branches.json");',
			"pos/arrow.ts":
				'const mk = (p: string) => join(p, ".mnemex");\nconst c = join(mk(p), "docs-cache");',
			"pos/worktree-dir.ts": 'const s = join(loc.worktreeDir, "store.json");',
			"pos/one-string.ts": 'const p = resolve(root, ".mnemex/index.db");',
			"pos/class-field.ts":
				'class T {\n\tprivate readonly dir = join(p, ".mnemex");\n\topen() {\n\t\treturn join(this.dir, "vectors");\n\t}\n}',
			"pos/method-return.ts":
				'class S {\n\tdir() {\n\t\treturn join(this.p, ".mnemex");\n\t}\n\tdb() {\n\t\treturn join(this.dir(), "index.db");\n\t}\n}',
			"pos/assigned-member.ts":
				'this.root = join(p, ".mnemex");\nconst db = join(this.root, "index.db");',
			"pos/nullish.ts":
				'const d = opts.dir ?? join(p, ".mnemex");\nconst db = join(d, "index.db");',
			"pos/ternary-segment.ts":
				'const db = join(p, legacy ? ".claudemem" : ".mnemex", "index.db");',
			"pos/default-param.ts":
				'function open(dir = join(p, ".mnemex")) {\n\treturn join(dir, "index.db-wal");\n}',
			"pos/path-module.ts": 'const s = path.join(p, ".mnemex", "store.json");',
			"pos/slash-array.ts": 'const db = [p, ".mnemex", "index.db"].join("/");',
			"pos/local-artifact-const.ts":
				'const LOCK = ".indexing.lock";\nconst l = join(p, ".mnemex", LOCK);',
			"pos/jsx-apostrophe.tsx":
				'const el = <text>Don\'t // not a comment</text>;\nconst db = join(p, ".mnemex", "index.db");',
			"pos/cross-file-use.ts":
				'const db = join(dataDir(p), "index.db");\nconst v = join(HOME_STORE, "vectors");',
			"neg/other-file.ts":
				'const a = join(projectPath, ".mnemex", "activity.jsonl");',
			"neg/overlay.ts":
				'const d = join(p, ".mnemex", "overlay");\nconst v = join(d, "vectors");',
			"neg/seam.ts": "const db = getIndexDbPathFor(resolveStoreLocation(p));",
			"neg/comments.ts":
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture SOURCE text; a template inside a comment.
				'// join(p, ".mnemex", "index.db")\n/* `${p}/.mnemex/vectors` */\nconst x = 1;',
			"neg/prose.ts":
				'console.log("keys live in ~/.mnemex/config.json, never in index.db");',
			"neg/glob.ts": 'const g = "**/.mnemex/**";',
			"neg/array-join.ts": 'const s = [".mnemex", "index.db"].join(", ");',
			"neg/jsx-text.tsx": "const el = <text>.mnemex/index.db</text>;",
			"neg/other-dir-name.ts":
				'const d = join(p, ".mnemexx", "index.db");\nconst e = join(p, "mnemex", "index.db");',
			"neg/not-a-path-call.ts":
				'const r = Promise.resolve(join(p, ".mnemex"));\nconst s = r.join("index.db");',
		};
		const artifacts = await seamStoreArtifacts();
		const scan = await scanStorePaths(
			Object.entries(fixtures).map(([rel, source]) => ({ rel, source })),
			artifacts,
		);
		expect([...scan.violations.keys()].sort()).toEqual(
			Object.keys(fixtures)
				.filter((rel) => rel.startsWith("pos/"))
				.sort(),
		);

		const minting: Record<string, string> = {
			"mint/project-config.ts": 'export const PROJECT_CONFIG_DIR = ".mnemex";',
			"mint/home.ts": 'const DIR = join(homedir(), ".mnemex");',
			"mint/const.ts": 'const NEW_DIR_NAME = ".mnemex";',
			"mint/via-constant.ts": "const memories = join(ws, PROJECT_CONFIG_DIR);",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture SOURCE text; the parser must see a template.
			"mint/template.ts": "const d = `${p}/.mnemex`;",
			"mint/ignore-list.ts":
				'const IGNORE = new Set(["node_modules", ".mnemex"]);',
			"nomint/deeper.ts": 'const a = join(p, ".mnemex", "activity.jsonl");',
			"nomint/glob.ts": 'const g = "**/.mnemex/**";',
			"nomint/prose.ts": 'const m = "Stored in ~/.mnemex/config.json";',
			"nomint/seam-worktree.ts":
				'const m = join(loc.worktreeDir, "memories");\nconst w = loc.worktreeDir;',
			"nomint/comment.ts": '// const d = join(p, ".mnemex");\nconst y = 2;',
			"nomint/derived.ts": 'const x = join(GLOBAL_CONFIG_DIR, "models.json");',
		};
		const minted = await scanStorePaths(
			Object.entries(minting).map(([rel, source]) => ({ rel, source })),
			artifacts,
		);
		expect([...minted.mintings.keys()].sort()).toEqual(
			Object.keys(minting)
				.filter((rel) => rel.startsWith("mint/"))
				.sort(),
		);
	}, 60_000);
});
