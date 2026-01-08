import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KNOWN_NODE_LIBS = [
	"react",
	"next",
	"vue",
	"nuxt",
	"svelte",
	"@sveltejs/kit",
	"angular",
	"@angular/core",
	"express",
	"fastify",
	"@nestjs/core",
	"hono",
	"koa",
	"prisma",
	"drizzle-orm",
	"typeorm",
	"zod",
	"vitest",
	"jest",
	"typescript",
];

export interface ProjectFacts {
	text: string;
	sourceMtimeMs?: number;
}

function formatNodeFacts(pkg: {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}): string {
	const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
	const matches = KNOWN_NODE_LIBS.filter((name) => deps[name]).map(
		(name) => `${name}@${deps[name]}`,
	);

	const lines: string[] = [];
	if (pkg.name) lines.push(`package: ${pkg.name}`);
	if (matches.length > 0) lines.push(`stack: ${matches.join(", ")}`);
	return lines.join("\n");
}

export function loadProjectFacts(projectPath: string): ProjectFacts {
	const packageJsonPath = join(projectPath, "package.json");
	if (!existsSync(packageJsonPath)) {
		return { text: "" };
	}

	try {
		const stat = statSync(packageJsonPath);
		const content = readFileSync(packageJsonPath, "utf-8");
		const parsed = JSON.parse(content) as {
			name?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		return {
			text: formatNodeFacts(parsed),
			sourceMtimeMs: stat.mtimeMs,
		};
	} catch {
		return { text: "" };
	}
}
