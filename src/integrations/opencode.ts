/**
 * OpenCode Integration Manager
 *
 * Manages installation of mnemex plugins for OpenCode.
 * Similar pattern to git hook manager.
 *
 * @see https://opencode.ai/docs/plugins/
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ============================================================================
// Types
// ============================================================================

export interface OpenCodeStatus {
	installed: boolean;
	pluginType?: "suggestion" | "tools" | "both";
	pluginDir?: string;
	configUpdated?: boolean;
	version?: string;
	isOpenCodeProject?: boolean;
}

export type PluginType = "suggestion" | "tools" | "both";

// ============================================================================
// Plugin Templates
// ============================================================================

// Get version from package.json at runtime
const VERSION = "0.7.1"; // Updated during build or read from package.json

const PLUGIN_MARKER = "// mnemex-integration";
const PLUGIN_VERSION_MARKER = `// mnemex-version: ${VERSION}`;

const SUGGESTION_PLUGIN = `${PLUGIN_MARKER}
${PLUGIN_VERSION_MARKER}
/**
 * mnemex Suggestion Plugin for OpenCode
 *
 * Silently tracks when mnemex could help.
 * No console output - avoids breaking OpenCode UI.
 *
 * Installed by: mnemex install opencode
 * @see https://github.com/MadAppGang/mnemex
 */

export const ClaudemumPlugin = async (ctx) => {
  const { $ } = ctx;

  // Check if mnemex is available (cross-platform)
  let ready = false;
  try {
    const result = await $\`mnemex status\`.quiet();
    ready = result.exitCode === 0;
  } catch {
    ready = false;
  }

  // No console output - it breaks OpenCode UI
  return {
    "tool.execute.before": async (input, output) => {
      // Silent - no tips to avoid UI interference
    },
  };
};

export default ClaudemumPlugin;
`;

const TOOLS_PLUGIN = `${PLUGIN_MARKER}
${PLUGIN_VERSION_MARKER}
/**
 * mnemex Custom Tools Plugin for OpenCode
 *
 * Adds mnemex as first-class tools the LLM can use.
 *
 * Installed by: mnemex install opencode
 * @see https://github.com/MadAppGang/mnemex
 */

import { tool } from "@opencode-ai/plugin";

export const ClaudemumToolsPlugin = async (ctx) => {
  const { $ } = ctx;

  // Check mnemex on load (cross-platform)
  // No console output - it breaks OpenCode UI
  let ready = false;
  try {
    const result = await $\`mnemex status\`.quiet();
    ready = result.exitCode === 0;
  } catch {
    ready = false;
  }

  return {
    tool: {
      mnemex_search: tool({
        description: "Semantic code search. Better than grep for natural language queries.",
        args: {
          query: tool.schema.string().describe("Natural language search query"),
          limit: tool.schema.number().optional().describe("Max results (default: 10)"),
        },
        async execute({ query, limit = 10 }) {
          const result = await $\`mnemex --agent search \${query} -n \${limit}\`;
          return result.stdout || "No results found";
        },
      }),

      mnemex_map: tool({
        description: "Structural overview with PageRank-ranked symbols. Use first to understand codebase.",
        args: {
          query: tool.schema.string().optional().describe("Focus area (optional)"),
        },
        async execute({ query }) {
          const cmd = query
            ? $\`mnemex --agent map \${query}\`
            : $\`mnemex --agent map\`;
          const result = await cmd;
          return result.stdout || "No symbols found";
        },
      }),

      mnemex_symbol: tool({
        description: "Find exact location of a symbol by name.",
        args: {
          name: tool.schema.string().describe("Symbol name to find"),
        },
        async execute({ name }) {
          const result = await $\`mnemex --agent symbol \${name}\`;
          return result.stdout || \`Symbol '\${name}' not found\`;
        },
      }),

      mnemex_callers: tool({
        description: "Find all code that calls a symbol. Essential before modifying code.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $\`mnemex --agent callers \${name}\`;
          return result.stdout || \`No callers found for '\${name}'\`;
        },
      }),

      mnemex_callees: tool({
        description: "Find all symbols that a function calls. Traces dependencies.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $\`mnemex --agent callees \${name}\`;
          return result.stdout || \`No callees found for '\${name}'\`;
        },
      }),

      mnemex_context: tool({
        description: "Full context: symbol + callers + callees. For complex modifications.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $\`mnemex --agent context \${name}\`;
          return result.stdout || \`Context not found for '\${name}'\`;
        },
      }),
    },
  };
};

export default ClaudemumToolsPlugin;
`;

// ============================================================================
// OpenCode Integration Manager
// ============================================================================

export class OpenCodeIntegrationManager {
	private projectPath: string;
	private pluginDir: string;
	private configPath: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		this.pluginDir = join(projectPath, ".opencode", "plugin");
		this.configPath = join(projectPath, "opencode.json");
	}

	/**
	 * Install mnemex plugin for OpenCode
	 */
	async install(type: PluginType = "tools"): Promise<void> {
		// Create plugin directory if needed
		if (!existsSync(this.pluginDir)) {
			mkdirSync(this.pluginDir, { recursive: true });
		}

		// Write plugin files based on type
		if (type === "suggestion" || type === "both") {
			const suggestionPath = join(this.pluginDir, "mnemex.ts");
			writeFileSync(suggestionPath, SUGGESTION_PLUGIN, "utf-8");
		}

		if (type === "tools" || type === "both") {
			const toolsPath = join(this.pluginDir, "mnemex-tools.ts");
			writeFileSync(toolsPath, TOOLS_PLUGIN, "utf-8");
		}

		// Update opencode.json
		await this.updateConfig(type);
	}

	/**
	 * Uninstall mnemex plugin
	 */
	async uninstall(): Promise<void> {
		// Remove plugin files
		const suggestionPath = join(this.pluginDir, "mnemex.ts");
		const toolsPath = join(this.pluginDir, "mnemex-tools.ts");

		if (existsSync(suggestionPath)) {
			const content = readFileSync(suggestionPath, "utf-8");
			if (content.includes(PLUGIN_MARKER)) {
				unlinkSync(suggestionPath);
			}
		}

		if (existsSync(toolsPath)) {
			const content = readFileSync(toolsPath, "utf-8");
			if (content.includes(PLUGIN_MARKER)) {
				unlinkSync(toolsPath);
			}
		}

		// Update opencode.json to remove our plugins
		await this.removeFromConfig();
	}

	/**
	 * Check installation status
	 */
	async status(): Promise<OpenCodeStatus> {
		const suggestionPath = join(this.pluginDir, "mnemex.ts");
		const toolsPath = join(this.pluginDir, "mnemex-tools.ts");

		let suggestionContent = "";
		let toolsContent = "";

		if (existsSync(suggestionPath)) {
			suggestionContent = readFileSync(suggestionPath, "utf-8");
		}
		if (existsSync(toolsPath)) {
			toolsContent = readFileSync(toolsPath, "utf-8");
		}

		const hasSuggestion = suggestionContent.includes(PLUGIN_MARKER);
		const hasTools = toolsContent.includes(PLUGIN_MARKER);

		if (!hasSuggestion && !hasTools) {
			return {
				installed: false,
				isOpenCodeProject: this.isOpenCodeProject(),
			};
		}

		let pluginType: PluginType;
		if (hasSuggestion && hasTools) {
			pluginType = "both";
		} else if (hasTools) {
			pluginType = "tools";
		} else {
			pluginType = "suggestion";
		}

		// Extract version from installed plugin
		let version: string | undefined;
		const contentToCheck = toolsContent || suggestionContent;
		const versionMatch = contentToCheck.match(/mnemex-version: ([^\n]+)/);
		if (versionMatch) {
			version = versionMatch[1].trim();
		}

		// Check if config is updated
		let configUpdated = false;
		if (existsSync(this.configPath)) {
			try {
				const config = JSON.parse(readFileSync(this.configPath, "utf-8"));
				const plugins = config.plugin || [];
				configUpdated = plugins.some((p: string) => p.includes("mnemex"));
			} catch {
				configUpdated = false;
			}
		}

		return {
			installed: true,
			pluginType,
			pluginDir: this.pluginDir,
			configUpdated,
			version,
			isOpenCodeProject: this.isOpenCodeProject(),
		};
	}

	/**
	 * Check if this is an OpenCode project
	 */
	isOpenCodeProject(): boolean {
		return (
			existsSync(this.configPath) ||
			existsSync(join(this.projectPath, ".opencode"))
		);
	}

	/**
	 * Update opencode.json to include our plugins
	 */
	private async updateConfig(type: PluginType): Promise<void> {
		let config: Record<string, unknown> = {};

		if (existsSync(this.configPath)) {
			try {
				config = JSON.parse(readFileSync(this.configPath, "utf-8"));
			} catch {
				// Invalid JSON, start fresh
				config = {};
			}
		}

		// Ensure plugin array exists
		if (!Array.isArray(config.plugin)) {
			config.plugin = [];
		}

		const plugins = config.plugin as string[];

		// Remove any existing mnemex plugins
		const filtered = plugins.filter((p) => !p.includes("mnemex"));

		// Add our plugins with absolute file:// paths (required by OpenCode)
		// Use pathToFileURL for cross-platform compatibility (handles Windows backslashes)
		if (type === "suggestion" || type === "both") {
			filtered.push(pathToFileURL(join(this.pluginDir, "mnemex.ts")).href);
		}
		if (type === "tools" || type === "both") {
			filtered.push(
				pathToFileURL(join(this.pluginDir, "mnemex-tools.ts")).href,
			);
		}

		config.plugin = filtered;

		// Write updated config
		writeFileSync(
			this.configPath,
			JSON.stringify(config, null, 2) + "\n",
			"utf-8",
		);
	}

	/**
	 * Remove our plugins from opencode.json
	 */
	private async removeFromConfig(): Promise<void> {
		if (!existsSync(this.configPath)) {
			return;
		}

		try {
			const config = JSON.parse(readFileSync(this.configPath, "utf-8"));

			if (Array.isArray(config.plugin)) {
				config.plugin = config.plugin.filter(
					(p: string) => !p.includes("mnemex"),
				);
			}

			writeFileSync(
				this.configPath,
				JSON.stringify(config, null, 2) + "\n",
				"utf-8",
			);
		} catch {
			// Ignore errors
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOpenCodeIntegration(
	projectPath: string,
): OpenCodeIntegrationManager {
	return new OpenCodeIntegrationManager(projectPath);
}
