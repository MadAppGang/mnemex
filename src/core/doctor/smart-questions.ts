/**
 * Smart question generator for doctor --generate
 *
 * Gathers project context from FileTracker, package.json, and diagnosis results
 * to generate targeted, context-aware questions instead of generic ones.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileTracker } from "../tracker.js";
import type { DoctorResult, ContextFileDiagnosis } from "./types.js";

export interface SmartQuestion {
	key: "nonDiscoverable" | "gotchas" | "buildCommands" | "neverDo";
	prompt: string;
	hint: string;
	/** Pre-filled context shown before the question */
	context?: string[];
}

interface ProjectContext {
	/** Top symbols by PageRank */
	topSymbols: Array<{ name: string; kind: string; pagerank: number }>;
	/** Detected frameworks/libraries from dependencies */
	frameworks: string[];
	/** Scripts from package.json */
	scripts: string[];
	/** Whether there's an existing context file and its issues */
	existingIssues: string[];
	/** High-severity criteria from diagnosis */
	criticalCriteria: string[];
	/** Number of symbols / files in the project */
	projectScale: { symbols: number; files: number };
}

/**
 * Gather project context from available data sources
 */
export function gatherProjectContext(
	projectPath: string,
	tracker: FileTracker | null,
	result: DoctorResult,
): ProjectContext {
	const ctx: ProjectContext = {
		topSymbols: [],
		frameworks: [],
		scripts: [],
		existingIssues: [],
		criticalCriteria: [],
		projectScale: { symbols: 0, files: 0 },
	};

	// 1. Top symbols from FileTracker
	if (tracker) {
		try {
			const symbols = tracker.getTopSymbols(10);
			ctx.topSymbols = symbols.map((s) => ({
				name: s.name,
				kind: s.kind,
				pagerank: s.pagerankScore,
			}));

			const stats = tracker.getSymbolGraphStats();
			ctx.projectScale = {
				symbols: stats.totalSymbols,
				files: 0, // Will be set from file tracker
			};
		} catch {
			// Index may not exist yet
		}
	}

	// 2. Parse package.json for frameworks and scripts
	const pkgPath = join(projectPath, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

			// Detect frameworks from dependencies
			const allDeps = {
				...(pkg.dependencies || {}),
				...(pkg.devDependencies || {}),
			};
			const frameworkMap: Record<string, string> = {
				react: "React",
				"react-dom": "React",
				next: "Next.js",
				vue: "Vue",
				nuxt: "Nuxt",
				svelte: "Svelte",
				"@sveltejs/kit": "SvelteKit",
				angular: "Angular",
				"@angular/core": "Angular",
				express: "Express",
				fastify: "Fastify",
				hono: "Hono",
				"effect-ts": "Effect",
				"@effect/io": "Effect",
				prisma: "Prisma",
				"@prisma/client": "Prisma",
				drizzle: "Drizzle ORM",
				"drizzle-orm": "Drizzle ORM",
				trpc: "tRPC",
				"@trpc/server": "tRPC",
				convex: "Convex",
				jest: "Jest",
				vitest: "Vitest",
				mocha: "Mocha",
				playwright: "Playwright",
				cypress: "Cypress",
				tailwindcss: "Tailwind CSS",
				"styled-components": "Styled Components",
				graphql: "GraphQL",
				"apollo-server": "Apollo GraphQL",
				mongoose: "Mongoose",
				typeorm: "TypeORM",
				sequelize: "Sequelize",
				bun: "Bun",
				esbuild: "esbuild",
				vite: "Vite",
				webpack: "Webpack",
				turbo: "Turborepo",
				pnpm: "pnpm",
				lerna: "Lerna",
			};

			const detected = new Set<string>();
			for (const dep of Object.keys(allDeps)) {
				const fw = frameworkMap[dep];
				if (fw) detected.add(fw);
			}
			ctx.frameworks = Array.from(detected);

			// Extract non-obvious scripts
			if (pkg.scripts) {
				const obviousScripts = [
					"start",
					"build",
					"test",
					"dev",
					"lint",
					"format",
					"prepare",
					"postinstall",
				];
				ctx.scripts = Object.entries(pkg.scripts)
					.filter(([name]) => !obviousScripts.includes(name))
					.map(
						([name, cmd]) =>
							`${name}: ${typeof cmd === "string" ? cmd : String(cmd)}`,
					);
			}
		} catch {
			// Malformed package.json
		}
	}

	// 3. Detect Go module
	const goModPath = join(projectPath, "go.mod");
	if (existsSync(goModPath)) {
		ctx.frameworks.push("Go");
	}

	// 4. Detect Python project
	const pyprojectPath = join(projectPath, "pyproject.toml");
	const requirementsPath = join(projectPath, "requirements.txt");
	if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
		ctx.frameworks.push("Python");
	}

	// 5. Detect Rust project
	const cargoPath = join(projectPath, "Cargo.toml");
	if (existsSync(cargoPath)) {
		ctx.frameworks.push("Rust");
	}

	// 6. Extract critical issues from diagnosis
	for (const diagnosis of result.diagnoses) {
		for (const criterion of diagnosis.criteria) {
			if (criterion.severity === "critical") {
				ctx.criticalCriteria.push(
					`${criterion.name}: ${criterion.issues[0] || "needs attention"}`,
				);
			}
		}
		// Collect existing file issues
		const issues = diagnosis.criteria
			.filter((c) => c.severity !== "good")
			.flatMap((c) => c.issues);
		ctx.existingIssues.push(...issues);
	}

	return ctx;
}

/**
 * Generate smart, context-aware questions based on project analysis
 */
export function generateSmartQuestions(ctx: ProjectContext): SmartQuestion[] {
	const questions: SmartQuestion[] = [];

	// Question 1: Non-discoverable knowledge (enriched with top symbols)
	const q1: SmartQuestion = {
		key: "nonDiscoverable",
		prompt:
			"What must an agent know about this project that ISN'T obvious from the code?",
		hint: "",
	};

	if (ctx.topSymbols.length > 0) {
		const symbolNames = ctx.topSymbols
			.slice(0, 5)
			.map((s) => `${s.name} (${s.kind}, PageRank ${s.pagerank.toFixed(3)})`);
		q1.context = [`Core abstractions detected: ${symbolNames.join(", ")}`];
		q1.prompt = `Your core abstractions are: ${ctx.topSymbols
			.slice(0, 3)
			.map((s) => s.name)
			.join(", ")}. What must agents know about them that ISN'T in the code?`;
	}

	if (ctx.frameworks.length > 0) {
		q1.hint = `Stack detected: ${ctx.frameworks.join(", ")}. Focus on non-obvious conventions.`;
	} else {
		q1.hint =
			"e.g., 'We use effect-ts for error handling', 'Auth tokens go through /api only'";
	}
	questions.push(q1);

	// Question 2: Gotchas (enriched with framework knowledge)
	const q2: SmartQuestion = {
		key: "gotchas",
		prompt: "",
		hint: "",
	};

	if (ctx.frameworks.length > 0) {
		q2.prompt = `What ${ctx.frameworks.join("/")} gotchas do agents keep getting wrong?`;
		// Framework-specific hints
		const fwHints: Record<string, string> = {
			"Next.js":
				"e.g., 'Server components can't use useState', 'API routes are in app/api/'",
			React:
				"e.g., 'Use React.memo for list items', 'No direct DOM manipulation'",
			Prisma: "e.g., 'Always use transactions for multi-table writes'",
			"Drizzle ORM": "e.g., 'Use .where() with eq(), never raw SQL strings'",
			tRPC: "e.g., 'Never import tRPC router types on the client'",
			Convex: "e.g., 'Queries must use .withIndex(), never .filter()'",
			Vitest: "e.g., 'Use vi.mock() not jest.mock()'",
			Jest: "e.g., 'Reset mocks in afterEach, not beforeEach'",
			Bun: "e.g., 'Use Bun.serve() not http.createServer()'",
		};
		const matchedHints = ctx.frameworks
			.map((fw) => fwHints[fw])
			.filter(Boolean);
		q2.hint =
			matchedHints[0] ||
			"e.g., 'Queries must use .withIndex(), never .filter()'";
	} else {
		q2.prompt = "Any tool/framework gotchas that agents keep getting wrong?";
		q2.hint = "e.g., 'Convex queries must use .withIndex(), never .filter()'";
	}
	questions.push(q2);

	// Question 3: Build commands (enriched with package.json scripts)
	const q3: SmartQuestion = {
		key: "buildCommands",
		prompt: "Non-obvious build/test/dev commands?",
		hint: "",
	};

	if (ctx.scripts.length > 0) {
		q3.context = [
			`Custom scripts found: ${ctx.scripts.slice(0, 5).join("; ")}`,
		];
		q3.hint =
			"Which of these scripts matter? Any that should NEVER be run by agents?";
	} else {
		q3.hint =
			"e.g., 'pnpm dev is already running, don't start it. Use pnpm build for CI only'";
	}
	questions.push(q3);

	// Question 4: Never-do rules (enriched with diagnosis issues)
	const q4: SmartQuestion = {
		key: "neverDo",
		prompt: "What should agents NEVER do in this repo?",
		hint: "",
	};

	if (ctx.criticalCriteria.length > 0) {
		q4.context = [
			`Current issues detected: ${ctx.criticalCriteria.slice(0, 3).join("; ")}`,
		];
		q4.hint = "Any architectural boundaries agents must respect?";
	} else {
		q4.hint =
			"e.g., 'Never modify the shared/ package directly, always go through the API layer'";
	}
	questions.push(q4);

	return questions;
}
