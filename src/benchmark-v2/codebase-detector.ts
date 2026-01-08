/**
 * Codebase Type Detection
 *
 * Automatically detects the type of codebase being benchmarked.
 * This allows for more meaningful cross-benchmark comparisons
 * (e.g., comparing models on React codebases vs Node.js backends).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Codebase Type Definitions
// ============================================================================

/**
 * Primary codebase categories
 */
export type CodebaseCategory =
	| "frontend"
	| "backend"
	| "fullstack"
	| "library"
	| "cli"
	| "mobile"
	| "ml"
	| "devops"
	| "unknown";

/**
 * Specific framework/technology stack
 */
export type CodebaseStack =
	// Frontend
	| "react"
	| "vue"
	| "angular"
	| "svelte"
	| "nextjs"
	| "nuxt"
	| "solid"
	| "qwik"
	// Backend
	| "express"
	| "fastify"
	| "nestjs"
	| "koa"
	| "hono"
	| "django"
	| "flask"
	| "fastapi"
	| "rails"
	| "spring"
	| "gin"
	| "fiber"
	| "actix"
	| "axum"
	// Mobile
	| "react-native"
	| "expo"
	| "flutter"
	| "swift"
	| "kotlin"
	// ML/AI
	| "pytorch"
	| "tensorflow"
	| "transformers"
	| "langchain"
	// CLI
	| "commander"
	| "yargs"
	| "clap"
	| "cobra"
	// DevOps
	| "terraform"
	| "pulumi"
	| "cdk"
	// Generic
	| "node"
	| "bun"
	| "deno"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "unknown";

/**
 * Complete codebase type information
 */
export interface CodebaseType {
	/** Primary language (typescript, javascript, python, go, rust, etc.) */
	language: string;
	/** Primary category (frontend, backend, fullstack, library, cli, etc.) */
	category: CodebaseCategory;
	/** Specific framework/stack detected */
	stack: CodebaseStack;
	/** Human-readable label for display */
	label: string;
	/** Confidence score (0-1) */
	confidence: number;
	/** Additional tags for filtering */
	tags: string[];
}

// ============================================================================
// Detection Logic
// ============================================================================

interface PackageJson {
	name?: string;
	main?: string;
	module?: string;
	exports?: unknown;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

interface DetectionContext {
	projectPath: string;
	packageJson?: PackageJson;
	files: string[];
	directories: string[];
}

/**
 * Detect codebase type from project path
 */
export async function detectCodebaseType(
	projectPath: string,
): Promise<CodebaseType> {
	const context = await buildDetectionContext(projectPath);

	// Try each detector in order of specificity
	const detectors = [
		detectFromPackageJson,
		detectFromPythonProject,
		detectFromGoProject,
		detectFromRustProject,
		detectFromDirectoryStructure,
	];

	for (const detector of detectors) {
		const result = detector(context);
		if (result && result.confidence > 0.5) {
			return result;
		}
	}

	// Fallback to basic language detection
	return detectBasicLanguage(context);
}

async function buildDetectionContext(
	projectPath: string,
): Promise<DetectionContext> {
	const context: DetectionContext = {
		projectPath,
		files: [],
		directories: [],
	};

	// Try to read package.json
	const packageJsonPath = join(projectPath, "package.json");
	if (existsSync(packageJsonPath)) {
		try {
			context.packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		} catch {
			// Ignore parse errors
		}
	}

	// Get top-level files and directories
	try {
		const { readdirSync, statSync } = await import("fs");
		const entries = readdirSync(projectPath);
		for (const entry of entries) {
			try {
				const stat = statSync(join(projectPath, entry));
				if (stat.isDirectory()) {
					context.directories.push(entry);
				} else {
					context.files.push(entry);
				}
			} catch {
				// Skip inaccessible entries
			}
		}
	} catch {
		// Ignore directory read errors
	}

	return context;
}

/**
 * Detect from package.json (Node.js/JS/TS projects)
 */
function detectFromPackageJson(context: DetectionContext): CodebaseType | null {
	const pkg = context.packageJson;
	if (!pkg) return null;

	const allDeps = {
		...pkg.dependencies,
		...pkg.devDependencies,
	};

	const hasDep = (name: string) => name in allDeps;
	const hasAnyDep = (...names: string[]) => names.some(hasDep);

	// Determine language
	const isTypeScript =
		hasDep("typescript") || context.files.includes("tsconfig.json");
	const language = isTypeScript ? "typescript" : "javascript";

	// Detect specific stacks
	const stacks: Array<{
		stack: CodebaseStack;
		category: CodebaseCategory;
		confidence: number;
		tags: string[];
	}> = [];

	// Frontend frameworks
	if (hasAnyDep("next", "next.js")) {
		stacks.push({
			stack: "nextjs",
			category: "fullstack",
			confidence: 0.95,
			tags: ["react", "ssr"],
		});
	}
	if (hasAnyDep("nuxt", "nuxt3")) {
		stacks.push({
			stack: "nuxt",
			category: "fullstack",
			confidence: 0.95,
			tags: ["vue", "ssr"],
		});
	}
	if (hasDep("react") && !hasAnyDep("next", "react-native", "expo")) {
		stacks.push({
			stack: "react",
			category: "frontend",
			confidence: 0.9,
			tags: ["spa"],
		});
	}
	if (hasDep("vue") && !hasDep("nuxt")) {
		stacks.push({
			stack: "vue",
			category: "frontend",
			confidence: 0.9,
			tags: ["spa"],
		});
	}
	if (hasAnyDep("@angular/core", "angular")) {
		stacks.push({
			stack: "angular",
			category: "frontend",
			confidence: 0.9,
			tags: ["spa"],
		});
	}
	if (hasDep("svelte")) {
		stacks.push({
			stack: "svelte",
			category: "frontend",
			confidence: 0.9,
			tags: ["spa"],
		});
	}
	if (hasDep("solid-js")) {
		stacks.push({
			stack: "solid",
			category: "frontend",
			confidence: 0.9,
			tags: ["spa"],
		});
	}

	// Mobile
	if (hasAnyDep("react-native", "expo")) {
		stacks.push({
			stack: hasDep("expo") ? "expo" : "react-native",
			category: "mobile",
			confidence: 0.95,
			tags: ["cross-platform"],
		});
	}

	// Backend frameworks
	if (hasAnyDep("@nestjs/core", "nestjs")) {
		stacks.push({
			stack: "nestjs",
			category: "backend",
			confidence: 0.95,
			tags: ["api", "enterprise"],
		});
	}
	if (hasDep("express") && !hasAnyDep("@nestjs/core", "next")) {
		stacks.push({
			stack: "express",
			category: "backend",
			confidence: 0.85,
			tags: ["api"],
		});
	}
	if (hasDep("fastify")) {
		stacks.push({
			stack: "fastify",
			category: "backend",
			confidence: 0.9,
			tags: ["api", "performance"],
		});
	}
	if (hasDep("hono")) {
		stacks.push({
			stack: "hono",
			category: "backend",
			confidence: 0.9,
			tags: ["api", "edge"],
		});
	}
	if (hasDep("koa")) {
		stacks.push({
			stack: "koa",
			category: "backend",
			confidence: 0.85,
			tags: ["api"],
		});
	}

	// CLI tools
	if (hasAnyDep("commander", "yargs", "meow", "cac", "clipanion")) {
		stacks.push({
			stack: "commander",
			category: "cli",
			confidence: 0.85,
			tags: ["tool"],
		});
	}

	// AI/ML
	if (
		hasAnyDep("langchain", "@langchain/core", "openai", "@anthropic-ai/sdk")
	) {
		stacks.push({
			stack: "langchain",
			category: "ml",
			confidence: 0.8,
			tags: ["ai", "llm"],
		});
	}

	// Pick highest confidence stack
	if (stacks.length > 0) {
		stacks.sort((a, b) => b.confidence - a.confidence);
		const best = stacks[0];
		return {
			language,
			category: best.category,
			stack: best.stack,
			label: `${language}-${best.category}`,
			confidence: best.confidence,
			tags: [language, best.category, best.stack, ...best.tags],
		};
	}

	// Generic Node.js project
	if (context.files.includes("package.json")) {
		// Check if it's a library
		const hasMain = pkg.main || pkg.exports || pkg.module;
		const hasNoApp = !hasAnyDep(
			"express",
			"fastify",
			"koa",
			"hono",
			"react",
			"vue",
			"angular",
		);

		if (hasMain && hasNoApp) {
			return {
				language,
				category: "library",
				stack: "node",
				label: `${language}-library`,
				confidence: 0.7,
				tags: [language, "library", "node", "npm"],
			};
		}

		return {
			language,
			category: "unknown",
			stack: "node",
			label: `${language}-node`,
			confidence: 0.6,
			tags: [language, "node"],
		};
	}

	return null;
}

/**
 * Detect Python projects
 */
function detectFromPythonProject(
	context: DetectionContext,
): CodebaseType | null {
	const hasPyProject = context.files.some((f) =>
		["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"].includes(f),
	);

	if (!hasPyProject) return null;

	// Try to read requirements or pyproject
	let deps: string[] = [];

	const reqPath = join(context.projectPath, "requirements.txt");
	if (existsSync(reqPath)) {
		try {
			const content = readFileSync(reqPath, "utf-8");
			deps = content
				.split("\n")
				.map((line) => line.split("==")[0].split(">=")[0].trim().toLowerCase());
		} catch {
			// Ignore
		}
	}

	const hasDep = (name: string) => deps.some((d) => d.includes(name));

	// ML/AI frameworks
	if (hasDep("torch") || hasDep("pytorch")) {
		return {
			language: "python",
			category: "ml",
			stack: "pytorch",
			label: "python-ml",
			confidence: 0.9,
			tags: ["python", "ml", "pytorch", "deep-learning"],
		};
	}
	if (hasDep("tensorflow") || hasDep("keras")) {
		return {
			language: "python",
			category: "ml",
			stack: "tensorflow",
			label: "python-ml",
			confidence: 0.9,
			tags: ["python", "ml", "tensorflow", "deep-learning"],
		};
	}
	if (hasDep("transformers") || hasDep("huggingface")) {
		return {
			language: "python",
			category: "ml",
			stack: "transformers",
			label: "python-ml",
			confidence: 0.9,
			tags: ["python", "ml", "transformers", "nlp"],
		};
	}
	if (hasDep("langchain")) {
		return {
			language: "python",
			category: "ml",
			stack: "langchain",
			label: "python-ai",
			confidence: 0.9,
			tags: ["python", "ai", "langchain", "llm"],
		};
	}

	// Web frameworks
	if (hasDep("fastapi")) {
		return {
			language: "python",
			category: "backend",
			stack: "fastapi",
			label: "python-backend",
			confidence: 0.9,
			tags: ["python", "backend", "fastapi", "api"],
		};
	}
	if (hasDep("django")) {
		return {
			language: "python",
			category: "backend",
			stack: "django",
			label: "python-backend",
			confidence: 0.9,
			tags: ["python", "backend", "django", "fullstack"],
		};
	}
	if (hasDep("flask")) {
		return {
			language: "python",
			category: "backend",
			stack: "flask",
			label: "python-backend",
			confidence: 0.85,
			tags: ["python", "backend", "flask", "api"],
		};
	}

	// CLI
	if (hasDep("click") || hasDep("typer") || hasDep("argparse")) {
		return {
			language: "python",
			category: "cli",
			stack: "python",
			label: "python-cli",
			confidence: 0.75,
			tags: ["python", "cli", "tool"],
		};
	}

	return {
		language: "python",
		category: "unknown",
		stack: "python",
		label: "python",
		confidence: 0.6,
		tags: ["python"],
	};
}

/**
 * Detect Go projects
 */
function detectFromGoProject(context: DetectionContext): CodebaseType | null {
	if (!context.files.includes("go.mod")) return null;

	// Try to read go.mod for dependencies
	let deps: string[] = [];
	const goModPath = join(context.projectPath, "go.mod");
	if (existsSync(goModPath)) {
		try {
			const content = readFileSync(goModPath, "utf-8");
			deps = content
				.split("\n")
				.filter((line) => line.includes("require") || line.startsWith("\t"));
		} catch {
			// Ignore
		}
	}

	const hasDep = (name: string) => deps.some((d) => d.includes(name));

	// Web frameworks
	if (hasDep("gin-gonic/gin")) {
		return {
			language: "go",
			category: "backend",
			stack: "gin",
			label: "go-backend",
			confidence: 0.9,
			tags: ["go", "backend", "gin", "api"],
		};
	}
	if (hasDep("gofiber/fiber")) {
		return {
			language: "go",
			category: "backend",
			stack: "fiber",
			label: "go-backend",
			confidence: 0.9,
			tags: ["go", "backend", "fiber", "api"],
		};
	}

	// CLI
	if (hasDep("spf13/cobra")) {
		return {
			language: "go",
			category: "cli",
			stack: "cobra",
			label: "go-cli",
			confidence: 0.85,
			tags: ["go", "cli", "cobra", "tool"],
		};
	}

	// Check for cmd directory (common Go CLI pattern)
	if (context.directories.includes("cmd")) {
		return {
			language: "go",
			category: "cli",
			stack: "go",
			label: "go-cli",
			confidence: 0.75,
			tags: ["go", "cli", "tool"],
		};
	}

	return {
		language: "go",
		category: "unknown",
		stack: "go",
		label: "go",
		confidence: 0.6,
		tags: ["go"],
	};
}

/**
 * Detect Rust projects
 */
function detectFromRustProject(context: DetectionContext): CodebaseType | null {
	if (!context.files.includes("Cargo.toml")) return null;

	// Try to read Cargo.toml for dependencies
	let deps: string[] = [];
	const cargoPath = join(context.projectPath, "Cargo.toml");
	if (existsSync(cargoPath)) {
		try {
			const content = readFileSync(cargoPath, "utf-8");
			deps = content.split("\n");
		} catch {
			// Ignore
		}
	}

	const hasDep = (name: string) => deps.some((d) => d.includes(name));

	// Web frameworks
	if (hasDep("actix-web") || hasDep("actix_web")) {
		return {
			language: "rust",
			category: "backend",
			stack: "actix",
			label: "rust-backend",
			confidence: 0.9,
			tags: ["rust", "backend", "actix", "api"],
		};
	}
	if (hasDep("axum")) {
		return {
			language: "rust",
			category: "backend",
			stack: "axum",
			label: "rust-backend",
			confidence: 0.9,
			tags: ["rust", "backend", "axum", "api"],
		};
	}

	// CLI
	if (hasDep("clap")) {
		return {
			language: "rust",
			category: "cli",
			stack: "clap",
			label: "rust-cli",
			confidence: 0.85,
			tags: ["rust", "cli", "clap", "tool"],
		};
	}

	// Check for binary vs library
	const isBinary = deps.some((d) => d.includes("[[bin]]"));
	if (isBinary) {
		return {
			language: "rust",
			category: "cli",
			stack: "rust",
			label: "rust-cli",
			confidence: 0.7,
			tags: ["rust", "cli", "tool"],
		};
	}

	return {
		language: "rust",
		category: "library",
		stack: "rust",
		label: "rust-library",
		confidence: 0.65,
		tags: ["rust", "library"],
	};
}

/**
 * Detect from directory structure
 */
function detectFromDirectoryStructure(
	context: DetectionContext,
): CodebaseType | null {
	const dirs = context.directories;

	// React/Vue patterns
	if (
		dirs.includes("components") &&
		(dirs.includes("pages") || dirs.includes("views"))
	) {
		return {
			language: "javascript",
			category: "frontend",
			stack: "unknown",
			label: "js-frontend",
			confidence: 0.6,
			tags: ["javascript", "frontend", "spa"],
		};
	}

	// Backend patterns
	if (
		dirs.includes("api") ||
		dirs.includes("routes") ||
		dirs.includes("controllers")
	) {
		return {
			language: "unknown",
			category: "backend",
			stack: "unknown",
			label: "backend",
			confidence: 0.5,
			tags: ["backend", "api"],
		};
	}

	return null;
}

/**
 * Basic language detection fallback
 */
function detectBasicLanguage(context: DetectionContext): CodebaseType {
	const files = context.files;

	if (files.includes("package.json")) {
		const hasTs = files.includes("tsconfig.json");
		return {
			language: hasTs ? "typescript" : "javascript",
			category: "unknown",
			stack: "node",
			label: hasTs ? "typescript" : "javascript",
			confidence: 0.5,
			tags: [hasTs ? "typescript" : "javascript", "node"],
		};
	}

	if (
		files.some(
			(f) =>
				f.endsWith(".py") || f === "requirements.txt" || f === "pyproject.toml",
		)
	) {
		return {
			language: "python",
			category: "unknown",
			stack: "python",
			label: "python",
			confidence: 0.5,
			tags: ["python"],
		};
	}

	if (files.includes("go.mod")) {
		return {
			language: "go",
			category: "unknown",
			stack: "go",
			label: "go",
			confidence: 0.5,
			tags: ["go"],
		};
	}

	if (files.includes("Cargo.toml")) {
		return {
			language: "rust",
			category: "unknown",
			stack: "rust",
			label: "rust",
			confidence: 0.5,
			tags: ["rust"],
		};
	}

	return {
		language: "unknown",
		category: "unknown",
		stack: "unknown",
		label: "unknown",
		confidence: 0.1,
		tags: [],
	};
}

/**
 * Format codebase type for display
 */
export function formatCodebaseType(type: CodebaseType): string {
	const parts = [type.language];
	if (type.category !== "unknown") {
		parts.push(type.category);
	}
	if (type.stack !== "unknown" && type.stack !== type.language) {
		parts.push(`(${type.stack})`);
	}
	return parts.join(" ");
}
