/**
 * Observe Tool
 *
 * MCP tool for recording session observations (cognitive memory).
 * Observations are embedded and stored alongside code chunks in LanceDB,
 * surfacing in future searches when semantically relevant.
 */

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createEmbeddingsClient } from "../../core/embeddings.js";
import { createIndexer } from "../../core/indexer.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerObserveTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager, config, logger } = deps;

	server.tool(
		"observe",
		"Record a session observation (gotcha, pattern, architecture note). " +
			"Observations are embedded and surface in future searches when relevant.",
		{
			content: z.string().min(5).max(2000).describe("The observation text"),
			affectedFiles: z
				.array(z.string())
				.default([])
				.describe("File paths this observation relates to"),
			observationType: z
				.enum(["gotcha", "pattern", "architecture", "procedure", "preference"])
				.default("pattern")
				.describe("Type of observation"),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.default(0.7)
				.describe("Confidence level (0-1)"),
		},
		async ({ content, affectedFiles, observationType, confidence }) => {
			const startTime = Date.now();

			try {
				const embeddingsClient = createEmbeddingsClient();
				const embedding = await embeddingsClient.embedOne(content);

				const id = createHash("sha256")
					.update(`observation:${content}:${affectedFiles.join(",")}`)
					.digest("hex")
					.slice(0, 16);

				const now = new Date().toISOString();
				const doc = {
					id,
					content,
					documentType: "session_observation" as const,
					filePath: affectedFiles[0] || "",
					fileHash: "",
					createdAt: now,
					enrichedAt: now,
					sourceIds: [],
					metadata: {
						observationType,
						confidence,
						affectedFiles,
					},
					vector: embedding,
				};

				// Write to LanceDB
				const indexer = createIndexer({
					projectPath: config.workspaceRoot,
				});
				const store = (indexer as any).vectorStore;
				if (store) {
					await store.addDocuments([doc]);
				} else {
					// Fallback: create store directly
					const { createVectorStore } = await import("../../core/store.js");
					const vs = await createVectorStore(config.workspaceRoot);
					await vs.addDocuments([doc]);
					await vs.close();
				}
				await indexer.close();

				logger.info(`observe: recorded observation ${id} (${observationType})`);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								observationId: id,
								observationType,
								confidence,
								affectedFiles,
								...buildFreshness(stateManager, startTime),
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
