/**
 * MCP `context` — which `file` arguments find their file (R1.4).
 *
 * Driven through the REAL tool handler, the REAL `IndexCache`, and an index the
 * BUILT entry point wrote (`path-spelling-fixture.ts`), so the stored symbol
 * paths are the ones a user's index holds — not a hand-written guess at them.
 *
 * PHASE 0 (characterisation, baseline `1ff08c3`): this file first recorded
 * today's behaviour, including the two defects —
 *   - an ABSOLUTE argument found NOTHING (`s.filePath === file` compares a
 *     repo-relative stored path with an absolute one, and `endsWith("/" + abs)`
 *     cannot match either);
 *   - an AMBIGUOUS bare filename (`helper.ts`, two files) silently answered from
 *     whichever file SQLite returned first.
 * Both pins passed at baseline (implementation log, Phase 0).
 *
 * PHASE 1 (R1.4, orchestrator ruling 2) changes exactly those two answers, and
 * nothing else:
 *   - absolute -> the real answer (a bug fix, recorded as such);
 *   - bare-filename suffix is a FALLBACK, used only when the exact lookup finds
 *     nothing AND exactly one indexed file matches; ambiguous -> nothing, with
 *     the candidates named. Every answer says how the file was matched
 *     (`fileResolution`), so a suffix match is never a silent narrowing.
 * Repo-relative and unique-bare answers are unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { IndexCache } from "../../../src/mcp/cache.js";
import { registerContextTools } from "../../../src/mcp/tools/context.js";
import type { ToolDeps } from "../../../src/mcp/tools/deps.js";
import {
	APP_FILE,
	HELPER_BODY_LINE,
	HELPER_FILE,
	type IndexedProject,
	indexedSpellingProject,
	MAIN_BODY_LINE,
	OTHER_HELPER_FILE,
} from "../../helpers/path-spelling-fixture.js";

const TIMEOUT_MS = 300_000;

type Handler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

interface ContextAnswer {
	fileResolution: {
		match: "exact" | "suffix" | "ambiguous" | "none";
		file: string | null;
		candidates?: string[];
	};
	enclosingSymbol: { name: string; file: string } | null;
	imports: string[];
	relatedSymbols: {
		callers: Array<{ name: string; file: string }>;
		callees: Array<{ name: string; file: string }>;
	};
}

let fx: IndexedProject;
let cache: IndexCache;
let context: Handler;

beforeAll(async () => {
	fx = await indexedSpellingProject("mnemex-mcp-context-");
	const logger = { info() {}, warn() {}, debug() {}, error() {} };
	// biome-ignore lint/suspicious/noExplicitAny: logger stub
	cache = new IndexCache(fx.project, "", 0, logger as any);
	const tools = new Map<string, Handler>();
	const server = {
		tool(name: string, _d: string, _s: unknown, handler: Handler) {
			tools.set(name, handler);
		},
	};
	const deps = {
		cache,
		stateManager: { getFreshness: () => ({}) },
		config: { workspaceRoot: fx.project },
		logger,
		serverStartTime: Date.now(),
		watcherActive: false,
	} as unknown as ToolDeps;
	// biome-ignore lint/suspicious/noExplicitAny: capturing fake McpServer
	registerContextTools(server as any, deps);
	const handler = tools.get("context");
	if (!handler) throw new Error("context tool was not registered");
	context = handler;
}, TIMEOUT_MS);

afterAll(() => {
	cache?.close();
	fx?.cleanup();
});

async function ask(file: string, line: number): Promise<ContextAnswer> {
	const res = await context({ file, line, radius: 2, includeBody: false });
	expect(res.isError ?? false, res.content[0]?.text).toBe(false);
	return JSON.parse(res.content[0].text) as ContextAnswer;
}

describe("MCP context: the file argument", () => {
	test("repo-relative: finds the enclosing symbol and its caller, repo-relative", async () => {
		const answer = await ask(HELPER_FILE, HELPER_BODY_LINE);
		expect(answer.enclosingSymbol?.name).toBe("helper");
		expect(answer.enclosingSymbol?.file).toBe(HELPER_FILE);
		expect(answer.relatedSymbols.callers).toEqual([
			expect.objectContaining({ name: "main", file: APP_FILE }),
		]);
		expect(answer.fileResolution).toEqual({
			match: "exact",
			file: HELPER_FILE,
		});
	});

	test("absolute: now the SAME answer as repo-relative (R1.4 bug fix; Phase 0 pinned it empty)", async () => {
		const byAbs = await ask(join(fx.project, HELPER_FILE), HELPER_BODY_LINE);
		const byRel = await ask(HELPER_FILE, HELPER_BODY_LINE);
		expect(byAbs.enclosingSymbol?.name).toBe("helper");
		// Output spelling is unchanged: stored, repo-relative.
		expect(byAbs.enclosingSymbol?.file).toBe(HELPER_FILE);
		const {
			freshness: _a,
			responseTimeMs: _b,
			...absRest
		} = byAbs as unknown as Record<string, unknown>;
		const {
			freshness: _c,
			responseTimeMs: _d,
			...relRest
		} = byRel as unknown as Record<string, unknown>;
		expect(absRest).toEqual(relRest);
	});

	test("imports: the file's own path is excluded, compared stored vs stored", async () => {
		// `main` calls `helper`, which lives in another file: that file is an
		// import of src/app.ts. `helper` calls `localTwice`, in its OWN file,
		// which is therefore not an import — for either spelling of the argument.
		for (const arg of [APP_FILE, join(fx.project, APP_FILE)]) {
			const answer = await ask(arg, MAIN_BODY_LINE);
			expect(answer.imports, arg).toEqual([HELPER_FILE]);
		}
		for (const arg of [HELPER_FILE, join(fx.project, HELPER_FILE)]) {
			const answer = await ask(arg, HELPER_BODY_LINE);
			expect(answer.relatedSymbols.callees, arg).toEqual([
				expect.objectContaining({ name: "localTwice", file: HELPER_FILE }),
			]);
			expect(answer.imports, arg).toEqual([]);
		}
	});

	test("bare filename with ONE match (`app.ts`): found through the suffix fallback, and SAYS so", async () => {
		const answer = await ask("app.ts", MAIN_BODY_LINE);
		expect(answer.enclosingSymbol?.name).toBe("main");
		expect(answer.enclosingSymbol?.file).toBe(APP_FILE);
		expect(answer.fileResolution).toEqual({ match: "suffix", file: APP_FILE });
	});

	test("ambiguous bare filename (`helper.ts`): NOTHING, with both candidates named", async () => {
		const answer = await ask("helper.ts", HELPER_BODY_LINE);
		expect(answer.enclosingSymbol).toBeNull();
		expect(answer.imports).toEqual([]);
		expect(answer.relatedSymbols).toEqual({ callers: [], callees: [] });
		expect(answer.fileResolution).toEqual({
			match: "ambiguous",
			file: null,
			candidates: [HELPER_FILE, OTHER_HELPER_FILE],
		});
	});

	test("a file nobody indexed: nothing, and `none`", async () => {
		const answer = await ask("src/nope.ts", 1);
		expect(answer.enclosingSymbol).toBeNull();
		expect(answer.fileResolution).toEqual({ match: "none", file: null });
	});
});
