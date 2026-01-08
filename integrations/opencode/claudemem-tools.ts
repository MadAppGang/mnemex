/**
 * claudemem Custom Tools Plugin for OpenCode
 *
 * Adds claudemem commands as first-class tools that OpenCode's LLM can use.
 *
 * Installation:
 *   1. Copy to .opencode/plugin/claudemem-tools.ts
 *   2. Add to opencode.json: { "plugin": ["file://.opencode/plugin/claudemem-tools.ts"] }
 *
 * Available tools:
 *   - claudemem_search: Semantic code search
 *   - claudemem_map: Structural overview with PageRank
 *   - claudemem_symbol: Find symbol definition
 *   - claudemem_callers: Find what calls a symbol (impact analysis)
 *   - claudemem_callees: Find what a symbol calls (dependencies)
 *   - claudemem_context: Full context (symbol + callers + callees)
 *
 * @see https://github.com/MadAppGang/claudemem
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

export const ClaudemumToolsPlugin: Plugin = async (ctx) => {
	const { $ } = ctx;

	// Check claudemem availability on load (cross-platform)
	let ready = false;
	try {
		const result = await $`claudemem status`.quiet();
		ready = result.exitCode === 0;
		if (ready) {
			console.log(
				"\n✅ claudemem tools loaded (search, map, symbol, callers, callees, context)\n",
			);
		} else {
			console.log("\n⚠️  claudemem not indexed. Run: claudemem index\n");
		}
	} catch {
		console.log(
			"\n⚠️  claudemem not installed. Install with: npm install -g claude-codemem\n",
		);
	}

	return {
		tool: {
			// Semantic code search
			claudemem_search: tool({
				description: `Semantic code search using natural language.
Better than grep for understanding code meaning.
Use for: "authentication flow", "error handling", "database queries"
Returns: Ranked results with file:line locations`,
				args: {
					query: tool.schema.string().describe("Natural language search query"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max results (default: 10)"),
				},
				async execute({ query, limit = 10 }) {
					try {
						const result =
							await $`claudemem --nologo search ${query} --raw -n ${limit}`;
						if (result.exitCode !== 0) {
							return `Error: claudemem search failed. Run 'claudemem status' to check index.`;
						}
						return result.stdout || "No results found";
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Repository structure map
			claudemem_map: tool({
				description: `Get structural overview of codebase with PageRank-ranked symbols.
Shows the most important functions, classes, and modules.
Use FIRST before diving into code to understand architecture.
PageRank > 0.05 = core abstraction, 0.01-0.05 = important, < 0.01 = utility`,
				args: {
					query: tool.schema
						.string()
						.optional()
						.describe("Focus area (optional, e.g., 'authentication')"),
					tokens: tool.schema
						.number()
						.optional()
						.describe("Max output tokens (default: 2000)"),
				},
				async execute({ query, tokens = 2000 }) {
					try {
						const cmd = query
							? $`claudemem --nologo map ${query} --raw --tokens ${tokens}`
							: $`claudemem --nologo map --raw --tokens ${tokens}`;
						const result = await cmd;
						if (result.exitCode !== 0) {
							return `Error: claudemem map failed. Run 'claudemem index' to rebuild.`;
						}
						return result.stdout || "No symbols found";
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Find symbol definition
			claudemem_symbol: tool({
				description: `Find exact location of a symbol (function, class, interface, etc.) by name.
Returns: file path, line numbers, kind, signature, PageRank score
Use when you know the symbol name and need its location.`,
				args: {
					name: tool.schema
						.string()
						.describe(
							"Symbol name to find (e.g., 'UserService', 'processPayment')",
						),
				},
				async execute({ name }) {
					try {
						const result = await $`claudemem --nologo symbol ${name} --raw`;
						if (result.exitCode !== 0) {
							return `Symbol '${name}' not found. Try claudemem_map to see available symbols.`;
						}
						return result.stdout || `Symbol '${name}' not found`;
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Find callers (impact analysis)
			claudemem_callers: tool({
				description: `Find all code that calls/references a symbol.
ESSENTIAL before modifying any code - shows impact radius.
Returns: List of callers with file:line locations
Use for: refactoring safety, understanding usage patterns`,
				args: {
					name: tool.schema
						.string()
						.describe("Symbol name to find callers for"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max callers to show (default: 10)"),
				},
				async execute({ name, limit = 10 }) {
					try {
						const result =
							await $`claudemem --nologo callers ${name} --raw --callers ${limit}`;
						if (result.exitCode !== 0) {
							return `No callers found for '${name}'. It may be unused or an entry point.`;
						}
						return result.stdout || `No callers found for '${name}'`;
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Find callees (dependencies)
			claudemem_callees: tool({
				description: `Find all symbols that a function/class calls or depends on.
Traces data flow and dependencies.
Returns: List of callees with file:line locations
Use for: understanding implementation, tracing execution flow`,
				args: {
					name: tool.schema
						.string()
						.describe("Symbol name to find callees for"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max callees to show (default: 15)"),
				},
				async execute({ name, limit = 15 }) {
					try {
						const result =
							await $`claudemem --nologo callees ${name} --raw --callees ${limit}`;
						if (result.exitCode !== 0) {
							return `No callees found for '${name}'. It may be a leaf function.`;
						}
						return result.stdout || `No callees found for '${name}'`;
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Full context (symbol + callers + callees)
			claudemem_context: tool({
				description: `Get full context: symbol definition + all callers + all callees.
Combines symbol, callers, and callees in one call.
Use for: complex modifications needing full awareness, understanding a symbol completely`,
				args: {
					name: tool.schema.string().describe("Symbol name to get context for"),
				},
				async execute({ name }) {
					try {
						const result = await $`claudemem --nologo context ${name} --raw`;
						if (result.exitCode !== 0) {
							return `Context not found for '${name}'. Try claudemem_symbol first.`;
						}
						return result.stdout || `Context not found for '${name}'`;
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Dead code detection (v0.4.0+)
			claudemem_dead_code: tool({
				description: `Find potentially unused code (zero callers + low PageRank).
Use for: cleanup, tech debt assessment, codebase hygiene.
Note: Exported symbols may be used externally.`,
				args: {
					includeExported: tool.schema
						.boolean()
						.optional()
						.describe("Include exported symbols (default: false)"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max results (default: 50)"),
				},
				async execute({ includeExported = false, limit = 50 }) {
					try {
						const exportedFlag = includeExported ? "--include-exported" : "";
						const result =
							await $`claudemem --nologo dead-code ${exportedFlag} -n ${limit} --raw`;
						if (result.exitCode !== 0) {
							return "No dead code found or command not available (requires v0.4.0+)";
						}
						return result.stdout || "No dead code found - codebase is clean!";
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),

			// Test gaps (v0.4.0+)
			claudemem_test_gaps: tool({
				description: `Find high-importance code lacking test coverage.
Identifies critical code (high PageRank) with zero test callers.
Use for: test planning, QA prioritization.`,
				args: {
					minPagerank: tool.schema
						.number()
						.optional()
						.describe("Minimum PageRank threshold (default: 0.01)"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max results (default: 30)"),
				},
				async execute({ minPagerank = 0.01, limit = 30 }) {
					try {
						const result =
							await $`claudemem --nologo test-gaps --min-pagerank ${minPagerank} -n ${limit} --raw`;
						if (result.exitCode !== 0) {
							return "No test gaps found or command not available (requires v0.4.0+)";
						}
						return result.stdout || "No test gaps found - excellent coverage!";
					} catch (e) {
						return `Error: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),
		},
	};
};

export default ClaudemumToolsPlugin;
