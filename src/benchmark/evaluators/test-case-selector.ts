/**
 * Test Case Selector
 *
 * Selects representative files and symbols from the indexed project
 * for benchmark testing.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeChunk } from "../../types.js";
import type { ASTGroundTruth, TestCase, TestCaseType } from "../types.js";
import { chunkFileByPath } from "../../core/chunker.js";
import { FileTracker } from "../../core/tracker.js";
import { getParserManager } from "../../parsers/parser-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface TestCaseSelectionOptions {
	/** Maximum number of test cases to select */
	maxTestCases: number;
	/** Types of test cases to include */
	types: TestCaseType[];
	/** Prefer diverse file sizes */
	diverseSizes?: boolean;
	/** Prefer diverse languages */
	diverseLanguages?: boolean;
}

// ============================================================================
// Test Case Selector
// ============================================================================

export class TestCaseSelector {
	private projectPath: string;
	private tracker: FileTracker;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		const dbPath = join(projectPath, ".claudemem", "index.db");
		this.tracker = new FileTracker(dbPath, projectPath);
	}

	/**
	 * Select test cases from the indexed project.
	 */
	async selectTestCases(
		options: TestCaseSelectionOptions,
	): Promise<TestCase[]> {
		// Get all indexed files
		const fileStates = this.tracker.getAllFiles();
		if (fileStates.length === 0) {
			throw new Error("No indexed files found. Run 'claudemem index' first.");
		}

		const testCases: TestCase[] = [];
		const typeCounts: Record<TestCaseType, number> = {
			file_summary: 0,
			symbol_summary: 0,
		};

		// Calculate target counts per type
		const targetPerType = Math.ceil(
			options.maxTestCases / options.types.length,
		);

		// Sort files for diversity if requested
		let sortedFiles = [...fileStates];
		if (options.diverseSizes) {
			sortedFiles = this.sortByDiversity(sortedFiles);
		}

		// Process files
		for (const fileState of sortedFiles) {
			if (testCases.length >= options.maxTestCases) break;

			try {
				const filePath = join(this.projectPath, fileState.path);
				if (!existsSync(filePath)) continue;

				const fileContent = readFileSync(filePath, "utf-8");
				const language = this.detectLanguage(fileState.path);
				if (!language) continue;

				// Get code chunks
				const chunks = await chunkFileByPath(
					fileContent,
					fileState.path,
					fileState.contentHash,
				);

				// Extract ground truth
				const groundTruth = await this.extractGroundTruth(
					fileContent,
					language,
					chunks,
				);

				// Add file summary test case
				if (
					options.types.includes("file_summary") &&
					typeCounts.file_summary < targetPerType
				) {
					testCases.push({
						id: `file:${fileState.path}`,
						type: "file_summary",
						filePath: fileState.path,
						fileContent,
						language,
						codeChunks: chunks,
						groundTruth,
					});
					typeCounts.file_summary++;
				}

				// Add symbol summary test cases
				if (options.types.includes("symbol_summary")) {
					const symbols = chunks.filter(
						(c) =>
							c.name &&
							(c.chunkType === "function" ||
								c.chunkType === "method" ||
								c.chunkType === "class"),
					);

					for (const symbol of symbols) {
						if (
							testCases.length >= options.maxTestCases ||
							typeCounts.symbol_summary >= targetPerType
						) {
							break;
						}

						const symbolGroundTruth = await this.extractSymbolGroundTruth(
							symbol,
							fileContent,
							language,
						);

						testCases.push({
							id: `symbol:${fileState.path}:${symbol.name}`,
							type: "symbol_summary",
							filePath: fileState.path,
							fileContent,
							language,
							codeChunk: symbol,
							groundTruth: symbolGroundTruth,
						});
						typeCounts.symbol_summary++;
					}
				}
			} catch (error) {
				// Skip files that can't be processed silently
			}
		}

		return testCases;
	}

	/**
	 * Sort files for diversity (mix of small, medium, large).
	 */
	private sortByDiversity<T extends { path: string }>(files: T[]): T[] {
		// Group by size
		const withSize = files.map((f) => {
			try {
				const content = readFileSync(join(this.projectPath, f.path), "utf-8");
				return { file: f, size: content.length };
			} catch {
				return { file: f, size: 0 };
			}
		});

		const small = withSize.filter((f) => f.size < 2000);
		const medium = withSize.filter((f) => f.size >= 2000 && f.size < 10000);
		const large = withSize.filter((f) => f.size >= 10000);

		// Interleave for diversity
		const result: T[] = [];
		const maxLen = Math.max(small.length, medium.length, large.length);

		for (let i = 0; i < maxLen; i++) {
			if (i < small.length) result.push(small[i].file);
			if (i < medium.length) result.push(medium[i].file);
			if (i < large.length) result.push(large[i].file);
		}

		return result;
	}

	/**
	 * Detect language from file path.
	 */
	private detectLanguage(filePath: string): string | null {
		const ext = filePath.split(".").pop()?.toLowerCase();
		const langMap: Record<string, string> = {
			ts: "typescript",
			tsx: "tsx",
			js: "javascript",
			jsx: "jsx",
			py: "python",
			go: "go",
			rs: "rust",
			c: "c",
			cpp: "cpp",
			java: "java",
		};
		return langMap[ext || ""] || null;
	}

	/**
	 * Extract ground truth from file content.
	 */
	private async extractGroundTruth(
		fileContent: string,
		language: string,
		chunks: CodeChunk[],
	): Promise<ASTGroundTruth> {
		// Extract exports from chunks
		const exports = chunks
			.filter((c) => c.chunkType === "function" || c.chunkType === "class")
			.map((c) => c.name)
			.filter((n): n is string => !!n);

		// Extract imports using regex (simple approach)
		const imports = this.extractImports(fileContent, language);

		return {
			exports,
			dependencies: imports,
			parameters: [],
			isAsync: false,
			sideEffects: [],
		};
	}

	/**
	 * Extract ground truth for a specific symbol.
	 */
	private async extractSymbolGroundTruth(
		chunk: CodeChunk,
		fileContent: string,
		language: string,
	): Promise<ASTGroundTruth> {
		// Extract parameters from signature
		const parameters = this.extractParameters(chunk.signature || chunk.content);

		// Check if async
		const isAsync = Boolean(
			chunk.content.includes("async ") || chunk.signature?.includes("async "),
		);

		// Extract return type
		const returnType = this.extractReturnType(chunk.signature || "");

		// Detect side effects
		const sideEffects = this.detectSideEffects(chunk.content);

		return {
			exports: [],
			dependencies: [],
			parameters,
			returnType,
			isAsync,
			sideEffects,
		};
	}

	/**
	 * Extract imports from file content.
	 */
	private extractImports(content: string, language: string): string[] {
		const imports: string[] = [];

		if (
			language === "typescript" ||
			language === "javascript" ||
			language === "tsx" ||
			language === "jsx"
		) {
			// ES imports
			const importRegex =
				/import\s+(?:(?:\{[^}]+\}|[^{}\s]+)\s+from\s+)?['"]([^'"]+)['"]/g;
			let match;
			while ((match = importRegex.exec(content)) !== null) {
				imports.push(match[1]);
			}

			// Require statements
			const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
			while ((match = requireRegex.exec(content)) !== null) {
				imports.push(match[1]);
			}
		} else if (language === "python") {
			// Python imports
			const importRegex = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
			let match;
			while ((match = importRegex.exec(content)) !== null) {
				imports.push(match[1] || match[2]);
			}
		}

		return [...new Set(imports)];
	}

	/**
	 * Extract parameters from function signature.
	 */
	private extractParameters(
		signature: string,
	): Array<{ name: string; type?: string }> {
		const params: Array<{ name: string; type?: string }> = [];

		// Match function parameters: (name: type, name: type, ...)
		const paramsMatch = signature.match(/\(([^)]*)\)/);
		if (!paramsMatch) return params;

		const paramsStr = paramsMatch[1];
		if (!paramsStr.trim()) return params;

		// Split by comma, handling nested generics
		const paramParts = this.splitParams(paramsStr);

		for (const part of paramParts) {
			const trimmed = part.trim();
			if (!trimmed) continue;

			// Handle destructuring
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				params.push({ name: "destructured" });
				continue;
			}

			// Handle rest parameters
			if (trimmed.startsWith("...")) {
				const restMatch = trimmed.match(/\.\.\.(\w+)/);
				if (restMatch) {
					params.push({ name: restMatch[1] });
				}
				continue;
			}

			// Extract name and type
			const colonIndex = trimmed.indexOf(":");
			if (colonIndex > 0) {
				const name = trimmed.slice(0, colonIndex).trim().replace(/\?$/, "");
				const type = trimmed.slice(colonIndex + 1).trim();
				params.push({ name, type });
			} else {
				// No type annotation
				const name = trimmed.split("=")[0].trim().replace(/\?$/, "");
				params.push({ name });
			}
		}

		return params;
	}

	/**
	 * Split parameters handling nested brackets.
	 */
	private splitParams(paramsStr: string): string[] {
		const result: string[] = [];
		let current = "";
		let depth = 0;

		for (const char of paramsStr) {
			if (char === "(" || char === "<" || char === "{" || char === "[") {
				depth++;
				current += char;
			} else if (char === ")" || char === ">" || char === "}" || char === "]") {
				depth--;
				current += char;
			} else if (char === "," && depth === 0) {
				result.push(current);
				current = "";
			} else {
				current += char;
			}
		}

		if (current.trim()) {
			result.push(current);
		}

		return result;
	}

	/**
	 * Extract return type from signature.
	 */
	private extractReturnType(signature: string): string | undefined {
		// Match ): ReturnType or ): Promise<ReturnType>
		const match = signature.match(/\)\s*:\s*([^{]+)/);
		if (match) {
			return match[1].trim();
		}
		return undefined;
	}

	/**
	 * Detect common side effects in code.
	 */
	private detectSideEffects(content: string): string[] {
		const effects: string[] = [];

		if (content.includes("console.")) effects.push("console output");
		if (content.includes("fetch(") || content.includes("axios"))
			effects.push("HTTP request");
		if (
			content.includes("fs.") ||
			content.includes("readFile") ||
			content.includes("writeFile")
		) {
			effects.push("file I/O");
		}
		if (
			content.includes("localStorage") ||
			content.includes("sessionStorage")
		) {
			effects.push("browser storage");
		}
		if (content.includes("setState") || content.includes("dispatch")) {
			effects.push("state mutation");
		}
		if (content.includes(".emit(") || content.includes(".publish(")) {
			effects.push("event emission");
		}

		return effects;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a test case selector for a project.
 */
export function createTestCaseSelector(projectPath: string): TestCaseSelector {
	return new TestCaseSelector(projectPath);
}
