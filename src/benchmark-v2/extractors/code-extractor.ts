/**
 * Code Extractor for Benchmarks
 *
 * Extracts code units from a codebase for benchmark evaluation.
 * Wraps the existing CodeUnitExtractor with benchmark-specific logic.
 */

import { createHash, randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";
import { minimatch } from "minimatch";

import {
	CodeUnitExtractor,
	createCodeUnitExtractor,
} from "../../core/ast/code-unit-extractor.js";
import type { CodeUnit, SupportedLanguage } from "../../types.js";
import { ExtractionError, FileParseError, UnsupportedLanguageError } from "../errors.js";
import type {
	BenchmarkCodeUnit,
	BenchmarkConfig,
	CodeUnitType,
	CodebaseInfo,
	SamplingStrategy,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** File extensions mapped to languages */
const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
	".ts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "jsx",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".java": "java",
};

/** Default patterns to exclude */
const DEFAULT_EXCLUDE_PATTERNS = [
	"**/node_modules/**",
	"**/.git/**",
	"**/vendor/**",
	"**/dist/**",
	"**/build/**",
	"**/__pycache__/**",
	"**/.next/**",
	"**/.nuxt/**",
	"**/coverage/**",
	"**/*.min.js",
	"**/*.d.ts",
];

/** Default patterns to include */
const DEFAULT_INCLUDE_PATTERNS = [
	"**/*.ts",
	"**/*.tsx",
	"**/*.js",
	"**/*.jsx",
	"**/*.py",
	"**/*.go",
	"**/*.rs",
	"**/*.java",
];

// ============================================================================
// Extraction Options
// ============================================================================

export interface ExtractionOptions {
	/** Root path of the project */
	projectPath: string;
	/** Patterns to include (globs) */
	includePatterns?: string[];
	/** Patterns to exclude (globs) */
	excludePatterns?: string[];
	/** Languages to include */
	languages?: string[];
	/** Code unit types to include */
	codeUnitTypes?: CodeUnitType[];
	/** Minimum lines of code */
	minLines?: number;
	/** Maximum lines of code */
	maxLines?: number;
	/** Skip test files */
	skipTests?: boolean;
	/** Skip generated files */
	skipGenerated?: boolean;
}

// ============================================================================
// Code Extractor Class
// ============================================================================

export class BenchmarkCodeExtractor {
	private codeUnitExtractor: CodeUnitExtractor;

	constructor() {
		this.codeUnitExtractor = createCodeUnitExtractor();
	}

	/**
	 * Extract all code units from the project
	 */
	async extractAll(
		options: ExtractionOptions
	): Promise<{ codeUnits: BenchmarkCodeUnit[]; codebaseInfo: CodebaseInfo }> {
		const {
			projectPath,
			includePatterns = DEFAULT_INCLUDE_PATTERNS,
			excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
			languages,
			codeUnitTypes,
			minLines = 5,
			maxLines = 500,
			skipTests = true,
			skipGenerated = true,
		} = options;

		// Find all matching files
		const files = await this.findFiles(projectPath, includePatterns, excludePatterns);

		// Filter by language if specified
		const filteredFiles = languages
			? files.filter((f) => {
					const lang = this.getLanguage(f);
					return lang && languages.includes(lang);
				})
			: files;

		// Track stats for codebase info
		const languageStats = new Map<string, number>();
		const allCodeUnits: BenchmarkCodeUnit[] = [];
		const errors: Array<{ file: string; error: string }> = [];

		// Process each file
		for (const file of filteredFiles) {
			try {
				const language = this.getLanguage(file);
				if (!language) continue;

				// Skip test files if requested
				if (skipTests && this.isTestFile(file)) continue;

				// Skip generated files if requested
				if (skipGenerated && this.isGeneratedFile(file)) continue;

				const units = await this.extractFromFile(
					join(projectPath, file),
					file,
					language
				);

				// Filter by type and size
				const filtered = units.filter((unit) => {
					// Filter by code unit type
					if (codeUnitTypes && !codeUnitTypes.includes(unit.type)) {
						return false;
					}

					// Filter by line count
					const lines = unit.metadata.endLine - unit.metadata.startLine + 1;
					if (lines < minLines || lines > maxLines) {
						return false;
					}

					return true;
				});

				// Track language stats
				languageStats.set(
					language,
					(languageStats.get(language) || 0) + filtered.length
				);

				allCodeUnits.push(...filtered);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push({ file, error: message });
			}
		}

		// Build codebase info
		const codebaseInfo: CodebaseInfo = {
			name: projectPath.split("/").pop() || "unknown",
			languages: Array.from(languageStats.keys()),
			totalCodeUnits: allCodeUnits.length,
			sampledCodeUnits: allCodeUnits.length, // Will be updated after sampling
		};

		return { codeUnits: allCodeUnits, codebaseInfo };
	}

	/**
	 * Extract code units from a single file
	 */
	async extractFromFile(
		absolutePath: string,
		relativePath: string,
		language: SupportedLanguage
	): Promise<BenchmarkCodeUnit[]> {
		try {
			const content = await readFile(absolutePath, "utf-8");
			const fileHash = createHash("sha256").update(content).digest("hex");

			// Use existing extractor
			const units = await this.codeUnitExtractor.extractUnits(
				content,
				relativePath,
				language,
				fileHash
			);

			// Convert to BenchmarkCodeUnit format
			return units.map((unit) => this.toBenchmarkCodeUnit(unit));
		} catch (error) {
			throw new FileParseError(
				relativePath,
				language,
				error instanceof Error ? error.message : String(error),
				error instanceof Error ? error : undefined
			);
		}
	}

	/**
	 * Sample code units using the specified strategy
	 */
	sampleCodeUnits(
		units: BenchmarkCodeUnit[],
		sampleSize: number,
		strategy: SamplingStrategy
	): BenchmarkCodeUnit[] {
		if (sampleSize >= units.length || strategy === "all") {
			return units;
		}

		switch (strategy) {
			case "random":
				return this.randomSample(units, sampleSize);
			case "stratified":
				return this.stratifiedSample(units, sampleSize);
			default:
				return this.randomSample(units, sampleSize);
		}
	}

	/**
	 * Random sampling
	 */
	private randomSample(
		units: BenchmarkCodeUnit[],
		sampleSize: number
	): BenchmarkCodeUnit[] {
		const shuffled = [...units].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, sampleSize);
	}

	/**
	 * Stratified sampling by language and code unit type
	 */
	private stratifiedSample(
		units: BenchmarkCodeUnit[],
		sampleSize: number
	): BenchmarkCodeUnit[] {
		// Group by language and type
		const groups = new Map<string, BenchmarkCodeUnit[]>();
		for (const unit of units) {
			const key = `${unit.language}:${unit.type}`;
			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(unit);
		}

		// Calculate per-group sample size (proportional)
		const result: BenchmarkCodeUnit[] = [];
		const groupSizes = Array.from(groups.entries()).map(([key, groupUnits]) => ({
			key,
			units: groupUnits,
			proportion: groupUnits.length / units.length,
		}));

		// Allocate samples proportionally
		let remaining = sampleSize;
		for (const group of groupSizes) {
			const groupSampleSize = Math.min(
				Math.ceil(sampleSize * group.proportion),
				group.units.length,
				remaining
			);
			const sampled = this.randomSample(group.units, groupSampleSize);
			result.push(...sampled);
			remaining -= sampled.length;
		}

		// If we still need more, take randomly from remaining
		if (result.length < sampleSize) {
			const usedIds = new Set(result.map((u) => u.id));
			const remaining = units.filter((u) => !usedIds.has(u.id));
			const extra = this.randomSample(remaining, sampleSize - result.length);
			result.push(...extra);
		}

		return result;
	}

	// ==========================================================================
	// Helper Methods
	// ==========================================================================

	private async findFiles(
		projectPath: string,
		includePatterns: string[],
		excludePatterns: string[]
	): Promise<string[]> {
		const files: string[] = [];

		const walk = (dir: string) => {
			try {
				const entries = readdirSync(dir, { withFileTypes: true });

				for (const entry of entries) {
					const fullPath = join(dir, entry.name);
					const relativePath = relative(projectPath, fullPath);

					// Check exclude patterns
					const isExcluded = excludePatterns.some((pattern) =>
						minimatch(relativePath, pattern, { dot: true })
					);
					if (isExcluded) continue;

					if (entry.isDirectory()) {
						walk(fullPath);
					} else if (entry.isFile()) {
						// Check include patterns
						const isIncluded = includePatterns.some((pattern) =>
							minimatch(relativePath, pattern, { dot: true })
						);
						if (isIncluded) {
							files.push(relativePath);
						}
					}
				}
			} catch {
				// Ignore directories we can't read
			}
		};

		walk(projectPath);
		return files;
	}

	private getLanguage(filePath: string): SupportedLanguage | null {
		const ext = extname(filePath);
		return EXTENSION_TO_LANGUAGE[ext] || null;
	}

	private isTestFile(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return (
			lower.includes(".test.") ||
			lower.includes(".spec.") ||
			lower.includes("_test.") ||
			lower.includes("_spec.") ||
			lower.includes("/test/") ||
			lower.includes("/tests/") ||
			lower.includes("/__tests__/")
		);
	}

	private isGeneratedFile(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return (
			lower.includes(".generated.") ||
			lower.includes(".gen.") ||
			lower.includes("/generated/") ||
			lower.includes("/gen/") ||
			lower.includes(".pb.") || // Protocol buffers
			lower.includes(".mock.") // Mock files
		);
	}

	private toBenchmarkCodeUnit(unit: CodeUnit): BenchmarkCodeUnit {
		return {
			id: unit.id,
			path: unit.filePath,
			name: unit.name || "anonymous",
			type: this.mapUnitType(unit.unitType),
			language: unit.language,
			content: unit.content,
			metadata: {
				startLine: unit.startLine,
				endLine: unit.endLine,
				signature: unit.signature,
				parameters: unit.metadata?.parameters?.map((p) => ({
					name: p.name,
					type: p.type,
					optional: false, // Default to non-optional since source doesn't track this
				})),
				returnType: unit.metadata?.returnType,
				visibility: unit.metadata?.visibility as "public" | "private" | "protected" | undefined,
				decorators: unit.metadata?.decorators,
				dependencies: unit.metadata?.importsUsed || [],
				exports: [],
				isAsync: unit.metadata?.isAsync,
			},
			relationships: {
				parentId: unit.parentId || undefined,
				childIds: [],
				callsIds: unit.metadata?.functionsCalled || [],
				calledByIds: [],
			},
		};
	}

	private mapUnitType(unitType: string): CodeUnitType {
		switch (unitType) {
			case "file":
				return "file";
			case "class":
				return "class";
			case "interface":
				return "class"; // Treat interfaces as classes for benchmarking
			case "function":
				return "function";
			case "method":
				return "method";
			case "module":
				return "module";
			case "type":
				return "function"; // Type aliases don't have a direct mapping
			case "enum":
				return "class"; // Enums treated as classes
			default:
				return "function";
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createBenchmarkCodeExtractor(): BenchmarkCodeExtractor {
	return new BenchmarkCodeExtractor();
}

// ============================================================================
// Phase Executor
// ============================================================================

import type { PhaseContext, PhaseResult } from "../pipeline/orchestrator.js";

/**
 * Create the extraction phase executor
 */
export function createExtractionPhaseExecutor(
	projectPathOverride?: string
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const extractor = createBenchmarkCodeExtractor();

		// Use override or config path
		const projectPath = projectPathOverride || config.projectPath;

		try {
			// Start the phase
			stateMachine.startPhase("extraction", 1);

			// Extract all code units
			const { codeUnits, codebaseInfo } = await extractor.extractAll({
				projectPath,
				languages: config.languages,
				codeUnitTypes: config.codeUnitTypes,
				skipTests: true,
				skipGenerated: true,
			});

			// Sample if needed
			const sampled = extractor.sampleCodeUnits(
				codeUnits,
				config.sampleSize,
				config.samplingStrategy
			);

			// Update codebase info with sample count
			codebaseInfo.sampledCodeUnits = sampled.length;

			// Persist to database
			db.insertCodeUnits(run.id, sampled);
			db.updateCodebaseInfo(run.id, codebaseInfo);

			// Update progress
			stateMachine.updateProgress("extraction", 1, undefined, `Extracted ${sampled.length} code units`);

			return {
				success: true,
				itemsProcessed: sampled.length,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				itemsProcessed: 0,
				error: message,
			};
		}
	};
}
