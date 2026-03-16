/**
 * Think Tool
 *
 * Reflection scratchpad — a no-op tool that lets the AI agent
 * organize thoughts without taking any action.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerThinkTools(server: McpServer): void {
	server.tool(
		"think",
		"A reflection scratchpad for organizing thoughts. " +
			"This tool does nothing — it simply returns the thought. " +
			"Use it to plan multi-step operations before executing them.",
		{
			thought: z.string().describe("Your thought or reasoning"),
		},
		async ({ thought }) => {
			return {
				content: [
					{
						type: "text" as const,
						text: thought,
					},
				],
			};
		},
	);
}
