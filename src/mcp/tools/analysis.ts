/**
 * Analysis Tools
 *
 * Three code analysis tools in one file:
 *   dead_code   - Find unreferenced exports with low PageRank
 *   test_gaps   - Find untested high-PageRank symbols
 *   impact      - Change blast radius analysis (transitive callers)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCodeAnalyzer } from "../../core/analysis/analyzer.js";
import { buildIndexState } from "../index-state.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerAnalysisTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager } = deps;

	// =========================================================================
	// dead_code
	// =========================================================================
	server.tool(
		"dead_code",
		"Find unreferenced symbols (zero callers and low PageRank). Useful for codebase cleanup.",
		{
			minReferences: z
				.number()
				.default(0)
				.describe(
					"Minimum reference count to consider dead (symbols with fewer are flagged). Default: 0",
				),
			filePattern: z
				.string()
				.optional()
				.describe("Glob pattern to restrict analysis to specific files"),
			limit: z
				.number()
				.max(200)
				.default(50)
				.describe("Maximum results to return (default: 50)"),
		},
		async ({ filePattern, limit }) => {
			const startTime = Date.now();

			try {
				const { tracker, branchId } = await cache.get();
				const analyzer = createCodeAnalyzer(tracker, branchId);

				const results = analyzer.findDeadCode({
					maxPageRank: 0.001,
					unexportedOnly: false,
					limit: limit ?? 50,
				});

				// Apply file pattern filter if provided
				const filtered = filePattern
					? results.filter((r) => {
							const pat = filePattern
								.replace(/\*\*/g, ".*")
								.replace(/\*/g, "[^/]*");
							return new RegExp(pat).test(r.symbol.filePath);
						})
					: results;

				const deadSymbols = filtered.map((r) => ({
					symbol: r.symbol.name,
					kind: r.symbol.kind,
					file: r.symbol.filePath,
					line: r.symbol.startLine,
					referenceCount: r.symbol.inDegree,
					pageRank: r.symbol.pagerankScore,
					reason: r.reason,
				}));

				const indexState = await buildIndexState(deps, startTime);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								deadSymbols,
								totalAnalyzed: deadSymbols.length,
								...buildFreshness(stateManager, startTime),
								...indexState,
							}),
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// test_gaps
	// =========================================================================
	server.tool(
		"test_gaps",
		"Find high-importance symbols (by PageRank) that have no test coverage. Prioritizes what to test next.",
		{
			filePattern: z
				.string()
				.default("src/")
				.describe(
					"Restrict to source files matching this path prefix (default: 'src/')",
				),
			testPattern: z
				.string()
				.optional()
				.describe(
					"Override test file pattern (default: auto-detected per language)",
				),
			limit: z
				.number()
				.max(100)
				.default(30)
				.describe("Maximum results to return (default: 30)"),
		},
		async ({ filePattern, limit }) => {
			const startTime = Date.now();

			try {
				const { tracker, branchId } = await cache.get();
				const analyzer = createCodeAnalyzer(tracker, branchId);

				const results = analyzer.findTestGaps({
					minPageRank: 0.005,
					limit: limit ?? 30,
				});

				// Filter by file pattern
				const filtered = filePattern
					? results.filter((r) => r.symbol.filePath.includes(filePattern))
					: results;

				const untestedSymbols = filtered.map((r) => ({
					symbol: r.symbol.name,
					kind: r.symbol.kind,
					file: r.symbol.filePath,
					line: r.symbol.startLine,
					pageRank: r.symbol.pagerankScore,
					testReferences: r.testCallerCount,
					callerCount: r.callerCount,
				}));

				const totalSourceSymbols = tracker
					.graph(branchId)
					.getAllSymbols().length;
				const untestedCount = untestedSymbols.length;
				const coveragePercent =
					totalSourceSymbols > 0
						? Math.round(
								((totalSourceSymbols - untestedCount) / totalSourceSymbols) *
									100,
							)
						: 100;

				const indexState = await buildIndexState(deps, startTime);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								untestedSymbols,
								summary: {
									totalSourceSymbols,
									untestedCount,
									coveragePercent,
								},
								...buildFreshness(stateManager, startTime),
								...indexState,
							}),
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// impact
	// =========================================================================
	server.tool(
		"impact",
		"Analyze the blast radius of changing a symbol. Returns all transitive callers grouped by file with a risk level.",
		{
			symbol: z.string().describe("Symbol name to analyze change impact for"),
			depth: z
				.number()
				.max(5)
				.default(3)
				.describe("Traversal depth for transitive callers (default: 3)"),
		},
		async ({ symbol: symbolName, depth }) => {
			const startTime = Date.now();

			try {
				const { tracker, branchId } = await cache.get();
				const analyzer = createCodeAnalyzer(tracker, branchId);
				const indexState = await buildIndexState(deps, startTime);

				const target = analyzer.findSymbolForImpact(symbolName);
				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `Symbol "${symbolName}" not found in index.`,
									...buildFreshness(stateManager, startTime),
									...indexState,
								}),
							},
						],
					};
				}

				const result = analyzer.findImpact(target.id, {
					maxDepth: depth ?? 3,
				});

				if (!result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `Could not analyze impact for "${symbolName}".`,
									...buildFreshness(stateManager, startTime),
									...indexState,
								}),
							},
						],
					};
				}

				const affectedFiles = Array.from(result.byFile.keys());
				const impactedSymbols = result.transitiveCallers.map((r) => ({
					symbol: r.symbol.name,
					file: r.symbol.filePath,
					line: r.symbol.startLine,
					depth: r.depth,
				}));

				// Risk level based on affected count
				const riskLevel =
					result.totalAffected > 20
						? "high"
						: result.totalAffected > 5
							? "medium"
							: "low";

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								directDependents: result.directCallers.length,
								transitiveDependents: result.totalAffected,
								affectedFiles,
								impactedSymbols,
								riskLevel,
								...buildFreshness(stateManager, startTime),
								...indexState,
							}),
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);
}
