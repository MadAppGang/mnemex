/**
 * Memory Tools
 *
 * MCP tools for project memory: write, read, list, delete.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerMemoryTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager, memoryStore } = deps;

	if (!memoryStore) return;

	server.tool(
		"memory_write",
		"Store a project memory (architectural decisions, patterns, preferences). " +
		"Memories persist across sessions in .claudemem/memories/.",
		{
			key: z
				.string()
				.describe("Memory key (alphanumeric, hyphens, underscores, max 128 chars)"),
			content: z.string().describe("Memory content (markdown)"),
		},
		async ({ key, content }) => {
			const startTime = Date.now();

			try {
				const memory = memoryStore.write(key, content);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								written: memory.key,
								createdAt: memory.createdAt,
								updatedAt: memory.updatedAt,
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

	server.tool(
		"memory_read",
		"Read a project memory by key.",
		{
			key: z.string().describe("Memory key to read"),
		},
		async ({ key }) => {
			const startTime = Date.now();

			try {
				const memory = memoryStore.read(key);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								memory: memory
									? {
											key: memory.key,
											content: memory.content,
											createdAt: memory.createdAt,
											updatedAt: memory.updatedAt,
										}
									: null,
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

	server.tool(
		"memory_list",
		"List all project memories (keys and timestamps, no content).",
		{},
		async () => {
			const startTime = Date.now();

			try {
				const memories = memoryStore.list();

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								memories,
								count: memories.length,
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

	server.tool(
		"memory_delete",
		"Delete a project memory by key.",
		{
			key: z.string().describe("Memory key to delete"),
		},
		async ({ key }) => {
			const startTime = Date.now();

			try {
				const deleted = memoryStore.delete(key);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								deleted,
								key,
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
