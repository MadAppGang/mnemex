/**
 * D1 required item 2 — the flag reaches the MCP `search_code` RESPONSE.
 *
 * "Not only `--agent` and one CLI line" is the wording of the decision, and it
 * is there because a flag nobody renders is the invisible failure D1 exists to
 * avoid. So this drives the REAL `search_code` handler and reads its real
 * response text: the trailing JSON object every `search_code` path carries
 * (A10), and the per-result lines.
 *
 * The indexer is stubbed, deliberately and narrowly: `searchScoped`'s decision
 * is asserted against a real `branches.json` and a real HEAD in
 * `branch-unknown-response.test.ts`, and the store's per-row `branchIds` are
 * asserted against real rows in `core/branch-scoped-search.test.ts`. What is
 * unproven WITHOUT this file is the part in between — that the tool puts both
 * on the wire — and a stub is the only way to pin that without an embedding
 * provider.
 *
 * FALSIFIED BY dropping either field from the handler: the assertions below
 * name it. The "guarding the guard" test runs the no-flag shape and shows the
 * same assertions failing to find it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchResult } from "../../../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** What the stubbed `Indexer.searchScoped` returns for the next call. */
let scoped: {
	results: SearchResult[];
	branchUnknown: boolean;
	branchLabel: string | null;
} = { results: [], branchUnknown: false, branchLabel: null };

class FakeIndexLockError extends Error {}
class FakeIndexedModelUnavailableError extends Error {}

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
		search: async () => scoped.results,
		searchScoped: async () => scoped,
		close: async () => {},
		getStatus: async () => ({ exists: false }),
	}),
}));

const { registerLegacyTools } = await import(
	"../../../src/mcp/tools/legacy.js"
);
const { IndexStateManager } = await import("../../../src/mcp/state-manager.js");
const { resolveStoreLocation } = await import(
	"../../../src/core/store-location.js"
);

interface CapturedTool {
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
}

function capturingServer(): {
	server: unknown;
	tools: Map<string, CapturedTool>;
} {
	const tools = new Map<string, CapturedTool>();
	return {
		server: {
			tool(
				name: string,
				_desc: string,
				_schema: unknown,
				handler: CapturedTool["handler"],
			) {
				tools.set(name, { handler });
			},
		},
		tools,
	};
}

function result(
	id: string,
	filePath: string,
	branches: string[] | undefined,
): SearchResult {
	return {
		chunk: {
			id,
			contentHash: `h-${id}`,
			content: `function ${id}() {}`,
			filePath,
			startLine: 1,
			endLine: 3,
			language: "typescript",
			chunkType: "function",
			name: id,
			fileHash: `f-${filePath}`,
		},
		score: 0.9,
		vectorScore: 0.9,
		keywordScore: 0.9,
		...(branches === undefined ? {} : { branchIds: [1], branches }),
	} as SearchResult;
}

async function runSearchCode(): Promise<{ text: string; trailer: unknown }> {
	const root = mkdtempSync(join(tmpdir(), "search-code-branch-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });

	const stateManager = new IndexStateManager(
		indexDir,
		resolveStoreLocation(dirname(indexDir)),
	);
	await stateManager.initialize();

	const { server, tools } = capturingServer();
	registerLegacyTools(
		server as never,
		{
			cache: {
				get: async () => {
					throw new Error("cache unavailable");
				},
				// biome-ignore lint/suspicious/noExplicitAny: minimal test double
			} as any,
			// biome-ignore lint/suspicious/noExplicitAny: the real state manager
			stateManager: stateManager as any,
			// biome-ignore lint/suspicious/noExplicitAny: only these fields are read
			config: { indexDir, workspaceRoot: root } as any,
			// biome-ignore lint/suspicious/noExplicitAny: logger stub
			logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
			serverStartTime: Date.now(),
			watcherActive: false,
			lspManager: null,
			// biome-ignore lint/suspicious/noExplicitAny: ToolDeps has more optional fields
		} as any,
	);

	const tool = tools.get("search_code");
	if (!tool) throw new Error("search_code not registered");
	const response = await tool.handler({ query: "parseConfig", path: root });
	const text = response.content[0].text;
	// A10: ONE trailing JSON object, on every path.
	const lastLine = text.trimEnd().split("\n").at(-1) as string;
	return { text, trailer: JSON.parse(lastLine) };
}

describe("D1 — search_code carries branch_unknown and per-row branches", () => {
	test("on an UNKNOWN branch: the flag is true, results are non-empty, every row is attributed", async () => {
		scoped = {
			results: [
				result("alpha", "/repo/src/a.ts", ["main"]),
				result("beta", "/repo/src/b.ts", ["main", "feat/x"]),
			],
			branchUnknown: true,
			branchLabel: "feat/brand-new",
		};

		const { text, trailer } = await runSearchCode();
		const json = trailer as {
			branch_unknown: boolean;
			branch: string | null;
			results: Array<{ id: string; branches: string[] }>;
		};

		// (1) The flag is on the RESPONSE OBJECT.
		expect(json.branch_unknown).toBe(true);
		expect(json.branch).toBe("feat/brand-new");

		// (2) Results are NON-EMPTY — D1 chose the superset precisely so this
		// path does not answer "nothing".
		expect(json.results).toHaveLength(2);

		// (3) Every row carries at least one branch label, in the object AND in
		// the prose an agent actually reads.
		expect(json.results.map((r) => r.branches)).toEqual([
			["main"],
			["main", "feat/x"],
		]);
		expect(text).toContain("Branches: main");
		expect(text).toContain("Branches: main, feat/x");

		// (4) The prose says plainly that the branch is not indexed.
		expect(text).toContain("is not in the index");
	});

	test("on a KNOWN branch: the flag is present and FALSE, so a consumer can rely on the key", async () => {
		scoped = {
			results: [result("alpha", "/repo/src/a.ts", ["main"])],
			branchUnknown: false,
			branchLabel: "main",
		};

		const { text, trailer } = await runSearchCode();
		const json = trailer as { branch_unknown: boolean; branch: string };

		expect(json).toHaveProperty("branch_unknown");
		expect(json.branch_unknown).toBe(false);
		expect(json.branch).toBe("main");
		expect(text).not.toContain("is not in the index");
	});

	test("the NO-RESULTS path carries the flag too", async () => {
		// The path that fails invisibly if nothing says why. An unknown branch
		// with an empty store must still say the branch is unknown.
		scoped = { results: [], branchUnknown: true, branchLabel: "feat/new" };

		const { trailer } = await runSearchCode();
		expect(trailer).toMatchObject({
			branch_unknown: true,
			branch: "feat/new",
		});
	});

	test("guarding the guard: a response WITHOUT attribution fails the same assertions", async () => {
		scoped = {
			results: [result("alpha", "/repo/src/a.ts", undefined)],
			branchUnknown: true,
			branchLabel: "feat/brand-new",
		};

		const { text, trailer } = await runSearchCode();
		const json = trailer as { results: Array<{ branches: string[] }> };

		// The flag still rides on the response...
		expect(text).toContain("is not in the index");
		// ...but with no `branches` on the row there is nothing to attribute,
		// and the assertions in the first test would not have found it.
		expect(json.results[0].branches).toEqual([]);
		expect(text).not.toContain("Branches:");
	});
});
