/**
 * claudemem Integration Plugin for OpenCode
 *
 * Intercepts grep/glob/list tools and suggests claudemem alternatives
 * for semantic code search.
 *
 * Installation:
 *   1. Copy to .opencode/plugin/claudemem.ts
 *   2. Add to opencode.json: { "plugin": ["file://.opencode/plugin/claudemem.ts"] }
 *
 * @see https://github.com/MadAppGang/claudemem
 */

import type { Plugin } from "@opencode-ai/plugin";

export const ClaudemumPlugin: Plugin = async (ctx) => {
	const { $ } = ctx;

	// Check if claudemem is available (cross-platform)
	let claudememAvailable = false;
	let claudememIndexed = false;

	try {
		const whichResult = await $`which claudemem`.quiet();
		claudememAvailable = whichResult.exitCode === 0;

		if (claudememAvailable) {
			const statusResult = await $`claudemem status`.quiet();
			claudememIndexed = statusResult.exitCode === 0;
		}
	} catch {
		claudememAvailable = false;
	}

	// Log status on plugin load
	if (!claudememAvailable) {
		console.log(
			"\n⚠️  claudemem not installed. Install with: npm install -g claude-codemem\n",
		);
	} else if (!claudememIndexed) {
		console.log("\n⚠️  claudemem not indexed. Run: claudemem index\n");
	} else {
		console.log("\n✅ claudemem plugin loaded\n");
	}

	return {
		"tool.execute.before": async (input, output) => {
			if (!claudememAvailable || !claudememIndexed) return;

			const tool = input.tool;
			const args = output.args;

			// Intercept grep with semantic queries
			if (tool === "grep" && args.pattern) {
				const pattern = String(args.pattern);

				// Detect semantic queries (not regex patterns)
				// Regex patterns typically have: [ ] ( ) | * + ? { } \ ^ $
				const isSemanticQuery =
					!pattern.match(/[\[\]\(\)\|\+\?\{\}\\^$]/) &&
					pattern.length > 3 &&
					pattern.includes(" "); // Natural language usually has spaces

				if (isSemanticQuery) {
					console.log(`\n💡 Tip: For semantic search, try:`);
					console.log(`   claudemem --nologo search "${pattern}" --raw`);
					console.log(`   claudemem --nologo map "${pattern}" --raw\n`);
				}
			}

			// Intercept glob for broad file searches
			if (tool === "glob" && args.pattern) {
				const pattern = String(args.pattern);

				// Detect broad patterns like **/*.ts or **/*
				if (pattern.startsWith("**")) {
					console.log(`\n💡 Tip: For structural overview, try:`);
					console.log(`   claudemem --nologo map --raw`);
					console.log(`   (Shows symbols ranked by importance)\n`);
				}
			}

			// Intercept list for directory exploration
			if (tool === "list") {
				console.log(`\n💡 Tip: For codebase structure with PageRank, try:`);
				console.log(`   claudemem --nologo map --raw\n`);
			}

			// Intercept read for multiple files (suggest targeted reads)
			if (tool === "read" && args.filePath) {
				// If reading a whole directory's worth, suggest map first
				const filePath = String(args.filePath);
				if (filePath.includes("*") || filePath.endsWith("/")) {
					console.log(`\n💡 Tip: Find specific code locations first:`);
					console.log(`   claudemem --nologo symbol <name> --raw`);
					console.log(`   (Then read specific file:line ranges)\n`);
				}
			}
		},
	};
};

export default ClaudemumPlugin;
