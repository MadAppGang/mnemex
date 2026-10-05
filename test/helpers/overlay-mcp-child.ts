/**
 * The REAL MCP search handlers (`search_code`, `search`) over a REAL index, in
 * a CHILD process (step 3, phase 6: MCP-1, R-5's MCP half).
 *
 * A child because the handlers build a real `Indexer`, which reads
 * `~/.mnemex/config.json` through `homedir()` — fixed at module load and blind
 * to a runtime `HOME` change (CLAUDE.md #25). The parent spawns this with
 * `sandboxEnv()` (`keychainSafeChildEnv()`, a sandbox HOME, a temp embed cache
 * and global lock), whose config points the embeddings at the parent's fake
 * server. Nothing here judges: it prints `RESULT <json>`.
 *
 *   overlay-mcp-child <search_code|search> <project> <query>
 *
 * `search_code` runs with `autoIndex: false`, so the dirty files stay dirty
 * (an auto-index would index them and make the overlay index-current). After
 * it, the activity log's newest `search_code` record is returned too, so the
 * parent can check the LEARNING record never names an overlay row (LOW 7).
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { getIndexDbPath } from "../../src/config.js";
import { resolveStoreLocation } from "../../src/core/store-location.js";
import { createFileTracker } from "../../src/core/tracker.js";
import { IndexStateManager } from "../../src/mcp/state-manager.js";
import { registerLegacyTools } from "../../src/mcp/tools/legacy.js";
import { registerSearchTools } from "../../src/mcp/tools/search.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());
function insideTmp(path: string | undefined): boolean {
	if (path === undefined) return false;
	return [tmpdir(), realpathSync.native(tmpdir())].some((t) =>
		path.startsWith(t),
	);
}
for (const name of ["MNEMEX_EMBED_CACHE_PATH", "MNEMEX_GLOBAL_LOCK_PATH"]) {
	if (!insideTmp(process.env[name])) {
		console.error(`${name} must point inside tmpdir()`);
		process.exit(64);
	}
}

const [tool, project, query] = process.argv.slice(2);
if ((tool !== "search_code" && tool !== "search") || !project || !query) {
	console.error(
		"usage: overlay-mcp-child <search_code|search> <project> <query>",
	);
	process.exit(64);
}

type Handler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
}>;
const tools = new Map<string, Handler>();
const server = {
	tool(name: string, _desc: string, _schema: unknown, handler: Handler) {
		tools.set(name, handler);
	},
};

const loc = resolveStoreLocation(project);
const stateManager = new IndexStateManager(loc.storeDir, loc);
await stateManager.initialize();
const deps = {
	// No graph cache: only the semantic backend contributes, so what the
	// response carries is what `searchScoped` returned.
	cache: {
		get: async () => {
			throw new Error("cache unavailable in this child");
		},
	},
	stateManager,
	config: { indexDir: loc.storeDir, workspaceRoot: project },
	logger: { info() {}, warn() {}, debug() {}, error() {} },
	serverStartTime: Date.now(),
	watcherActive: false,
	lspManager: null,
};
// biome-ignore lint/suspicious/noExplicitAny: a capturing stand-in for McpServer
registerLegacyTools(server as any, deps as any);
// biome-ignore lint/suspicious/noExplicitAny: a capturing stand-in for McpServer
registerSearchTools(server as any, deps as any);

const handler = tools.get(tool);
if (!handler) throw new Error(`${tool} not registered`);
const response = await handler(
	tool === "search_code"
		? { query, path: project, autoIndex: false, limit: 10 }
		: { query, limit: 10 },
);
const text = response.content[0]?.text ?? "";

let activity: unknown = null;
if (tool === "search_code") {
	const tracker = createFileTracker(getIndexDbPath(project), project);
	try {
		const rows = tracker
			.getActivity(0, 500)
			.filter((r: { type: string }) => r.type === "search_code");
		const last = rows.at(-1) as { metadata: string } | undefined;
		activity = last ? JSON.parse(last.metadata) : null;
	} finally {
		tracker.close();
	}
}

console.log(`RESULT ${JSON.stringify({ text, activity })}`);
process.exit(0);
