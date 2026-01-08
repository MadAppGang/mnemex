#!/usr/bin/env bun

/**
 * Download tree-sitter grammar WASM files
 *
 * Downloads pre-built WASM grammars from GitHub releases or builds them.
 */

import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readdirSync,
	copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const GRAMMARS_DIR = join(import.meta.dir, "../grammars");

// Grammar packages and their expected WASM file names
const GRAMMAR_PACKAGES = [
	{
		pkg: "tree-sitter-typescript",
		wasm: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
	},
	{ pkg: "tree-sitter-javascript", wasm: ["tree-sitter-javascript.wasm"] },
	{ pkg: "tree-sitter-python", wasm: ["tree-sitter-python.wasm"] },
	{ pkg: "tree-sitter-go", wasm: ["tree-sitter-go.wasm"] },
	{ pkg: "tree-sitter-rust", wasm: ["tree-sitter-rust.wasm"] },
	{ pkg: "tree-sitter-c", wasm: ["tree-sitter-c.wasm"] },
	{ pkg: "tree-sitter-cpp", wasm: ["tree-sitter-cpp.wasm"] },
	{ pkg: "tree-sitter-java", wasm: ["tree-sitter-java.wasm"] },
	// NEW: Web languages
	{ pkg: "tree-sitter-html", wasm: ["tree-sitter-html.wasm"] },
	{ pkg: "tree-sitter-css", wasm: ["tree-sitter-css.wasm"] },
	// NEW: Shell scripts
	{ pkg: "tree-sitter-bash", wasm: ["tree-sitter-bash.wasm"] },
	// NEW: Config formats
	{ pkg: "tree-sitter-json", wasm: ["tree-sitter-json.wasm"] },
	{ pkg: "tree-sitter-yaml", wasm: ["tree-sitter-yaml.wasm"] },
	// NEW: Dingo (pre-built WASM committed to repo)
	{ pkg: "tree-sitter-dingo", wasm: ["tree-sitter-dingo.wasm"] },
];

// Alternative: GitHub release URLs for pre-built WASM files
const GITHUB_RELEASES: Record<string, string> = {
	"tree-sitter-typescript.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-typescript.wasm",
	"tree-sitter-tsx.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-tsx.wasm",
	"tree-sitter-javascript.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-javascript.wasm",
	"tree-sitter-python.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-python.wasm",
	"tree-sitter-go.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-go.wasm",
	"tree-sitter-rust.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-rust.wasm",
	"tree-sitter-c.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-c.wasm",
	"tree-sitter-cpp.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-cpp.wasm",
	"tree-sitter-java.wasm":
		"https://github.com/nickshanks347/tree-sitter-wasm/releases/download/v1.0.3/tree-sitter-java.wasm",
	// NEW: Web languages (from AntoineCoumo releases)
	"tree-sitter-html.wasm":
		"https://github.com/AntoineCoumo/tree-sitter-grammars-wasm/releases/download/v1.0.3/tree-sitter-html.wasm",
	"tree-sitter-css.wasm":
		"https://github.com/AntoineCoumo/tree-sitter-grammars-wasm/releases/download/v1.0.3/tree-sitter-css.wasm",
	// NEW: Shell scripts (from AntoineCoumo releases)
	"tree-sitter-bash.wasm":
		"https://github.com/AntoineCoumo/tree-sitter-grammars-wasm/releases/download/v1.0.3/tree-sitter-bash.wasm",
	// NEW: Config formats (from AntoineCoumo releases)
	"tree-sitter-json.wasm":
		"https://github.com/AntoineCoumo/tree-sitter-grammars-wasm/releases/download/v1.0.3/tree-sitter-json.wasm",
};

// Backup: UNPKG CDN for npm packages that include pre-built WASM
const UNPKG_URLS: Record<string, string> = {
	"tree-sitter-javascript.wasm":
		"https://unpkg.com/tree-sitter-javascript/tree-sitter-javascript.wasm",
	"tree-sitter-typescript.wasm":
		"https://unpkg.com/tree-sitter-typescript/tree-sitter-typescript.wasm",
	"tree-sitter-tsx.wasm":
		"https://unpkg.com/tree-sitter-typescript/tree-sitter-tsx.wasm",
	"tree-sitter-python.wasm":
		"https://unpkg.com/tree-sitter-python/tree-sitter-python.wasm",
	"tree-sitter-go.wasm": "https://unpkg.com/tree-sitter-go/tree-sitter-go.wasm",
	"tree-sitter-rust.wasm":
		"https://unpkg.com/tree-sitter-rust/tree-sitter-rust.wasm",
	"tree-sitter-c.wasm": "https://unpkg.com/tree-sitter-c/tree-sitter-c.wasm",
	"tree-sitter-cpp.wasm":
		"https://unpkg.com/tree-sitter-cpp/tree-sitter-cpp.wasm",
	"tree-sitter-java.wasm":
		"https://unpkg.com/tree-sitter-java/tree-sitter-java.wasm",
	// NEW: Web languages (unpkg fallback)
	"tree-sitter-html.wasm":
		"https://unpkg.com/tree-sitter-html@latest/tree-sitter-html.wasm",
	"tree-sitter-css.wasm":
		"https://unpkg.com/tree-sitter-css@latest/tree-sitter-css.wasm",
	// NEW: Shell scripts (unpkg fallback)
	"tree-sitter-bash.wasm":
		"https://unpkg.com/tree-sitter-bash@latest/tree-sitter-bash.wasm",
	// NEW: Config formats (unpkg fallback)
	"tree-sitter-json.wasm":
		"https://unpkg.com/tree-sitter-json@latest/tree-sitter-json.wasm",
	"tree-sitter-yaml.wasm":
		"https://unpkg.com/tree-sitter-yaml@latest/tree-sitter-yaml.wasm",
};

async function downloadFromUrl(name: string, url: string): Promise<boolean> {
	const outPath = join(GRAMMARS_DIR, name);

	try {
		const response = await fetch(url);
		if (!response.ok) {
			return false;
		}

		const buffer = await response.arrayBuffer();
		if (buffer.byteLength < 1000) {
			// Too small, probably an error page
			return false;
		}

		writeFileSync(outPath, Buffer.from(buffer));
		return true;
	} catch {
		return false;
	}
}

async function downloadGrammar(name: string): Promise<void> {
	const outPath = join(GRAMMARS_DIR, name);

	// Skip if already exists
	if (existsSync(outPath)) {
		console.log(`✓ ${name} (cached)`);
		return;
	}

	console.log(`⬇ Downloading ${name}...`);

	// Try GitHub releases first
	if (GITHUB_RELEASES[name]) {
		if (await downloadFromUrl(name, GITHUB_RELEASES[name])) {
			console.log(`✓ ${name} (from GitHub)`);
			return;
		}
	}

	// Try UNPKG
	if (UNPKG_URLS[name]) {
		if (await downloadFromUrl(name, UNPKG_URLS[name])) {
			console.log(`✓ ${name} (from UNPKG)`);
			return;
		}
	}

	console.error(`✗ ${name}: Could not download from any source`);
	console.error(
		`  You may need to build it manually: npx tree-sitter build --wasm`,
	);
}

async function copyTreeSitterRuntime(): Promise<void> {
	// Copy the core tree-sitter.wasm from node_modules
	// This is required because Bun bundles absolute paths at build time
	const destPath = join(GRAMMARS_DIR, "tree-sitter.wasm");

	if (existsSync(destPath)) {
		console.log("✓ tree-sitter.wasm (cached)");
		return;
	}

	// Try multiple possible locations for node_modules
	const possibleSources = [
		join(import.meta.dir, "../node_modules/web-tree-sitter/tree-sitter.wasm"),
		// When installed globally, web-tree-sitter might be a peer
		join(import.meta.dir, "../../web-tree-sitter/tree-sitter.wasm"),
	];

	for (const sourcePath of possibleSources) {
		if (existsSync(sourcePath)) {
			console.log("⬇ Copying tree-sitter.wasm runtime...");
			copyFileSync(sourcePath, destPath);
			console.log("✓ tree-sitter.wasm (from node_modules)");
			return;
		}
	}

	console.warn(
		"⚠ tree-sitter.wasm not found in node_modules - will use default location",
	);
}

async function main() {
	console.log("\n📦 Downloading tree-sitter grammars...\n");

	// Ensure grammars directory exists
	if (!existsSync(GRAMMARS_DIR)) {
		mkdirSync(GRAMMARS_DIR, { recursive: true });
	}

	// Copy the core tree-sitter runtime WASM
	await copyTreeSitterRuntime();

	// Collect all WASM file names
	const allWasmFiles = new Set<string>();
	for (const { wasm } of GRAMMAR_PACKAGES) {
		for (const file of wasm) {
			allWasmFiles.add(file);
		}
	}

	// Download each grammar
	for (const file of allWasmFiles) {
		await downloadGrammar(file);
	}

	console.log("\n✅ Done!\n");
}

main().catch(console.error);
