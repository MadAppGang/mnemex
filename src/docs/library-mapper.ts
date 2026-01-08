/**
 * Library Mapper
 *
 * Detects dependencies from project manifest files and maps them
 * to their documentation sources.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetectedDependency, PackageEcosystem } from "./types.js";
import {
	extractMajorVersion,
	parseVersionForEcosystem,
} from "./version-parser.js";

// ============================================================================
// Manifest File Detection
// ============================================================================

/** Manifest file info */
interface ManifestInfo {
	filename: string;
	ecosystem: PackageEcosystem;
	parser: (content: string) => DetectedDependency[];
}

/** Known manifest files and their parsers */
const MANIFEST_FILES: ManifestInfo[] = [
	{ filename: "package.json", ecosystem: "npm", parser: parsePackageJson },
	{
		filename: "requirements.txt",
		ecosystem: "pypi",
		parser: parseRequirementsTxt,
	},
	{ filename: "pyproject.toml", ecosystem: "pypi", parser: parsePyprojectToml },
	{ filename: "go.mod", ecosystem: "go", parser: parseGoMod },
	{ filename: "Cargo.toml", ecosystem: "cargo", parser: parseCargoToml },
];

// ============================================================================
// Library Mapper Class
// ============================================================================

export class LibraryMapper {
	/**
	 * Detect all dependencies from a project directory
	 */
	async detectDependencies(projectPath: string): Promise<DetectedDependency[]> {
		const allDeps: DetectedDependency[] = [];

		for (const manifest of MANIFEST_FILES) {
			const filePath = join(projectPath, manifest.filename);
			try {
				const content = await readFile(filePath, "utf-8");
				const deps = manifest.parser(content);
				allDeps.push(...deps);
			} catch {
				// File doesn't exist or can't be read - skip
			}
		}

		// Deduplicate by name (prefer first occurrence)
		const seen = new Set<string>();
		return allDeps.filter((dep) => {
			const key = dep.name.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/**
	 * Get major version for documentation API calls
	 */
	getMajorVersion(dep: DetectedDependency): string | undefined {
		return dep.majorVersion || extractMajorVersion(dep.version);
	}
}

// ============================================================================
// Package.json Parser (npm/yarn/pnpm/bun)
// ============================================================================

function parsePackageJson(content: string): DetectedDependency[] {
	const deps: DetectedDependency[] = [];

	try {
		const pkg = JSON.parse(content);

		// Parse dependencies
		if (pkg.dependencies) {
			for (const [name, version] of Object.entries(pkg.dependencies)) {
				deps.push(createDependency(name, version as string, "npm", false));
			}
		}

		// Parse devDependencies
		if (pkg.devDependencies) {
			for (const [name, version] of Object.entries(pkg.devDependencies)) {
				deps.push(createDependency(name, version as string, "npm", true));
			}
		}

		// Parse peerDependencies (treat as regular deps)
		if (pkg.peerDependencies) {
			for (const [name, version] of Object.entries(pkg.peerDependencies)) {
				// Don't duplicate if already in dependencies
				if (!deps.some((d) => d.name === name)) {
					deps.push(createDependency(name, version as string, "npm", false));
				}
			}
		}
	} catch {
		// Invalid JSON - skip
	}

	return deps;
}

// ============================================================================
// requirements.txt Parser (pip)
// ============================================================================

function parseRequirementsTxt(content: string): DetectedDependency[] {
	const deps: DetectedDependency[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip comments and empty lines
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
			continue;
		}

		// Skip URLs and paths
		if (
			trimmed.includes("://") ||
			trimmed.startsWith(".") ||
			trimmed.startsWith("/")
		) {
			continue;
		}

		// Parse "package==1.0.0", "package>=1.0.0", "package~=1.0.0", etc.
		const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([<>=!~]+\s*[\d.]+.*)?/);
		if (match) {
			const name = match[1];
			const version = match[2]?.trim() || "*";
			deps.push(createDependency(name, version, "pypi", false));
		}
	}

	return deps;
}

// ============================================================================
// pyproject.toml Parser (Poetry, PDM, Flit)
// ============================================================================

function parsePyprojectToml(content: string): DetectedDependency[] {
	const deps: DetectedDependency[] = [];

	// Simple TOML parsing for dependencies
	// Handles [project.dependencies] and [tool.poetry.dependencies]

	// Match [project.dependencies] array format
	const projectDepsMatch = content.match(
		/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/,
	);
	if (projectDepsMatch) {
		const depsArray = projectDepsMatch[1];
		const entries = depsArray.match(/"([^"]+)"/g) || [];
		for (const entry of entries) {
			const spec = entry.replace(/"/g, "");
			const match = spec.match(/^([a-zA-Z0-9_-]+)\s*([<>=!~]+.*)?/);
			if (match) {
				deps.push(createDependency(match[1], match[2] || "*", "pypi", false));
			}
		}
	}

	// Match [tool.poetry.dependencies] table format
	const poetrySection = content.match(
		/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/,
	);
	if (poetrySection) {
		const lines = poetrySection[1].split("\n");
		for (const line of lines) {
			// Match: package = "^1.0.0" or package = {version = "^1.0.0", ...}
			const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
			const tableMatch = line.match(
				/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/,
			);

			if (simpleMatch) {
				deps.push(
					createDependency(simpleMatch[1], simpleMatch[2], "pypi", false),
				);
			} else if (tableMatch) {
				deps.push(
					createDependency(tableMatch[1], tableMatch[2], "pypi", false),
				);
			}
		}
	}

	return deps;
}

// ============================================================================
// go.mod Parser
// ============================================================================

function parseGoMod(content: string): DetectedDependency[] {
	const deps: DetectedDependency[] = [];
	const lines = content.split("\n");
	let inRequire = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Track require block
		if (trimmed.startsWith("require (")) {
			inRequire = true;
			continue;
		}
		if (trimmed === ")" && inRequire) {
			inRequire = false;
			continue;
		}

		// Parse require line: github.com/user/repo v1.0.0
		if (inRequire || trimmed.startsWith("require ")) {
			const requireLine = trimmed.replace(/^require\s+/, "");
			const match = requireLine.match(/^(\S+)\s+(v[\d.]+)/);
			if (match) {
				deps.push(createDependency(match[1], match[2], "go", false));
			}
		}
	}

	return deps;
}

// ============================================================================
// Cargo.toml Parser (Rust)
// ============================================================================

function parseCargoToml(content: string): DetectedDependency[] {
	const deps: DetectedDependency[] = [];

	// Match [dependencies] section
	const depsSection = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
	if (depsSection) {
		const lines = depsSection[1].split("\n");
		for (const line of lines) {
			// Match: package = "1.0" or package = { version = "1.0", ... }
			const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
			const tableMatch = line.match(
				/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/,
			);

			if (simpleMatch) {
				deps.push(
					createDependency(simpleMatch[1], simpleMatch[2], "cargo", false),
				);
			} else if (tableMatch) {
				deps.push(
					createDependency(tableMatch[1], tableMatch[2], "cargo", false),
				);
			}
		}
	}

	// Match [dev-dependencies] section
	const devDepsSection = content.match(
		/\[dev-dependencies\]([\s\S]*?)(?=\[|$)/,
	);
	if (devDepsSection) {
		const lines = devDepsSection[1].split("\n");
		for (const line of lines) {
			const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
			const tableMatch = line.match(
				/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/,
			);

			if (simpleMatch) {
				deps.push(
					createDependency(simpleMatch[1], simpleMatch[2], "cargo", true),
				);
			} else if (tableMatch) {
				deps.push(
					createDependency(tableMatch[1], tableMatch[2], "cargo", true),
				);
			}
		}
	}

	return deps;
}

// ============================================================================
// Helpers
// ============================================================================

function createDependency(
	name: string,
	version: string,
	ecosystem: PackageEcosystem,
	isDev: boolean,
): DetectedDependency {
	const parsed = parseVersionForEcosystem(version, ecosystem);

	return {
		name,
		version,
		majorVersion: parsed ? `v${parsed.major}` : undefined,
		ecosystem,
		isDev,
	};
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a LibraryMapper instance
 */
export function createLibraryMapper(): LibraryMapper {
	return new LibraryMapper();
}
