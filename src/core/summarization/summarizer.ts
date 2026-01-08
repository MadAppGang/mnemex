/**
 * Bottom-Up Summarizer
 *
 * Generates summaries for code units in hierarchical order:
 * 1. Methods/functions first (deepest level)
 * 2. Classes/interfaces next (inject child summaries)
 * 3. Files last (inject exported unit summaries)
 *
 * This ensures parent summaries can reference child summaries
 * for richer context and better search relevance.
 */

import type {
	CodeUnit,
	ILLMClient,
	UnitType,
	ASTMetadata,
	LLMMessage,
} from "../../types.js";
import type { VectorStore } from "../store.js";
import {
	SUMMARY_SYSTEM_PROMPT,
	buildFunctionSummaryPrompt,
	buildClassSummaryPrompt,
	buildFileSummaryPrompt,
	type FunctionSummaryInput,
	type ClassSummaryInput,
	type FileSummaryInput,
} from "./prompts.js";

// ============================================================================
// Types
// ============================================================================

export interface SummarizationOptions {
	/** Maximum concurrent LLM calls */
	concurrency?: number;
	/** Progress callback */
	onProgress?: (completed: number, total: number, status: string) => void;
	/** Skip units that already have summaries */
	skipExisting?: boolean;
}

export interface SummaryResult {
	unitId: string;
	summary: string;
}

export interface SummarizationResult {
	summariesGenerated: number;
	errors: Array<{ unitId: string; error: string }>;
	durationMs: number;
}

// ============================================================================
// Summarizer Class
// ============================================================================

export class BottomUpSummarizer {
	private llmClient: ILLMClient;
	private store: VectorStore;
	private summaryCache: Map<string, string>;

	constructor(llmClient: ILLMClient, store: VectorStore) {
		this.llmClient = llmClient;
		this.store = store;
		this.summaryCache = new Map();
	}

	/**
	 * Summarize all code units in a file using bottom-up order
	 */
	async summarizeFile(
		filePath: string,
		options: SummarizationOptions = {},
	): Promise<SummarizationResult> {
		const startTime = Date.now();
		const { onProgress, skipExisting = false, concurrency = 5 } = options;

		// Get all units for this file
		const units = await this.store.getCodeUnitsByFile(filePath);
		if (units.length === 0) {
			return { summariesGenerated: 0, errors: [], durationMs: 0 };
		}

		// Group by depth
		const maxDepth = await this.store.getMaxDepth(filePath);
		const errors: Array<{ unitId: string; error: string }> = [];
		let summariesGenerated = 0;

		// Process from deepest level to shallowest (bottom-up)
		for (let depth = maxDepth; depth >= 0; depth--) {
			const unitsAtDepth = units.filter((u) => u.depth === depth);
			if (unitsAtDepth.length === 0) continue;

			if (onProgress) {
				onProgress(
					summariesGenerated,
					units.length,
					`Processing depth ${depth} (${unitsAtDepth.length} units)`,
				);
			}

			// Process in batches with concurrency
			for (let i = 0; i < unitsAtDepth.length; i += concurrency) {
				const batch = unitsAtDepth.slice(i, i + concurrency);
				const results = await Promise.allSettled(
					batch.map((unit) => this.summarizeUnit(unit, units, skipExisting)),
				);

				for (let j = 0; j < results.length; j++) {
					const result = results[j];
					const unit = batch[j];

					if (result.status === "fulfilled" && result.value) {
						// Cache the summary for use by parent units
						this.summaryCache.set(unit.id, result.value);
						// Update in store
						await this.store.updateUnitSummary(unit.id, result.value);
						summariesGenerated++;
					} else if (result.status === "rejected") {
						errors.push({
							unitId: unit.id,
							error: result.reason?.message || String(result.reason),
						});
					}
				}

				if (onProgress) {
					onProgress(
						summariesGenerated,
						units.length,
						`Depth ${depth}: ${Math.min(i + concurrency, unitsAtDepth.length)}/${unitsAtDepth.length}`,
					);
				}
			}
		}

		return {
			summariesGenerated,
			errors,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Summarize all code units across multiple files
	 */
	async summarizeFiles(
		filePaths: string[],
		options: SummarizationOptions = {},
	): Promise<SummarizationResult> {
		const startTime = Date.now();
		let totalGenerated = 0;
		const allErrors: Array<{ unitId: string; error: string }> = [];

		for (let i = 0; i < filePaths.length; i++) {
			const filePath = filePaths[i];

			if (options.onProgress) {
				options.onProgress(
					i,
					filePaths.length,
					`Summarizing ${filePath.split("/").pop()}`,
				);
			}

			const result = await this.summarizeFile(filePath, {
				...options,
				onProgress: undefined, // Don't pass nested progress
			});

			totalGenerated += result.summariesGenerated;
			allErrors.push(...result.errors);
		}

		return {
			summariesGenerated: totalGenerated,
			errors: allErrors,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Summarize a single code unit
	 */
	private async summarizeUnit(
		unit: CodeUnit,
		allUnits: CodeUnit[],
		skipExisting: boolean,
	): Promise<string | null> {
		// Check if we should skip
		if (skipExisting) {
			const existing = this.summaryCache.get(unit.id);
			if (existing) return null;
		}

		// Build prompt based on unit type
		const prompt = this.buildPrompt(unit, allUnits);
		if (!prompt) return null;

		// Call LLM
		const messages: LLMMessage[] = [
			{ role: "system", content: SUMMARY_SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];
		const response = await this.llmClient.complete(messages);

		// Clean up response
		return response.content.trim();
	}

	/**
	 * Build the appropriate prompt for a unit type
	 */
	private buildPrompt(unit: CodeUnit, allUnits: CodeUnit[]): string | null {
		const metadata = unit.metadata || {};

		switch (unit.unitType) {
			case "function":
			case "method":
				return this.buildFunctionPrompt(unit, metadata);

			case "class":
			case "interface":
				return this.buildClassPrompt(unit, allUnits, metadata);

			case "file":
				return this.buildFilePrompt(unit, allUnits, metadata);

			default:
				// For types, enums, etc., use function prompt as fallback
				return this.buildFunctionPrompt(unit, metadata);
		}
	}

	/**
	 * Build prompt for function/method summary
	 */
	private buildFunctionPrompt(unit: CodeUnit, metadata: ASTMetadata): string {
		const input: FunctionSummaryInput = {
			language: unit.language,
			unitType: unit.unitType,
			name: unit.name || "anonymous",
			signature: unit.signature || unit.name || "unknown",
			filePath: unit.filePath,
			visibility: metadata.visibility,
			isAsync: metadata.isAsync,
			decorators: metadata.decorators,
			calledBy: [], // TODO: Could be populated from reference graph
			code: this.truncateCode(unit.content, 150), // Limit to ~150 lines
		};

		return buildFunctionSummaryPrompt(input);
	}

	/**
	 * Build prompt for class/interface summary
	 */
	private buildClassPrompt(
		unit: CodeUnit,
		allUnits: CodeUnit[],
		metadata: ASTMetadata,
	): string {
		// Get child method summaries
		const children = allUnits.filter((u) => u.parentId === unit.id);
		const methodSummaries = children
			.filter((c) => c.unitType === "method" || c.unitType === "function")
			.map((c) => ({
				name: c.name || "anonymous",
				summary: this.summaryCache.get(c.id) || "No summary available",
			}));

		// Extract properties from code (simplified - could use AST)
		const properties = this.extractProperties(unit.content, unit.language);

		const input: ClassSummaryInput = {
			language: unit.language,
			unitType: unit.unitType,
			name: unit.name || "anonymous",
			filePath: unit.filePath,
			extendsFrom: undefined, // TODO: Extract from AST
			implementsInterfaces: undefined, // TODO: Extract from AST
			methodSummaries,
			properties,
			usedBy: [], // TODO: Could be populated from reference graph
			code: this.truncateCode(unit.content, 200),
		};

		return buildClassSummaryPrompt(input);
	}

	/**
	 * Build prompt for file summary
	 */
	private buildFilePrompt(
		unit: CodeUnit,
		allUnits: CodeUnit[],
		metadata: ASTMetadata,
	): string {
		// Get top-level children (classes, functions, exports)
		const children = allUnits.filter((u) => u.parentId === unit.id);

		// Build exports list from exported children
		const exports = children
			.filter(
				(c) => c.metadata?.isExported || c.metadata?.visibility === "exported",
			)
			.map((c) => ({
				name: c.name || "anonymous",
				type: c.unitType,
				summary: this.summaryCache.get(c.id),
			}));

		// Non-exported internals
		const internals = children
			.filter(
				(c) => !c.metadata?.isExported && c.metadata?.visibility !== "exported",
			)
			.map((c) => ({
				name: c.name || "anonymous",
				type: c.unitType,
			}));

		const input: FileSummaryInput = {
			language: unit.language,
			filePath: unit.filePath,
			moduleName: undefined, // TODO: Extract from package.json or similar
			exports,
			internals: internals.length > 0 ? internals : undefined,
			externalDeps: metadata.importsUsed?.filter(
				(i) => !i.startsWith(".") && !i.startsWith("@app"),
			),
			internalDeps: metadata.importsUsed?.filter(
				(i) => i.startsWith(".") || i.startsWith("@app"),
			),
			importedBy: [], // TODO: Could be populated from reference graph
		};

		return buildFileSummaryPrompt(input);
	}

	/**
	 * Truncate code to max lines while preserving structure
	 */
	private truncateCode(code: string, maxLines: number): string {
		const lines = code.split("\n");
		if (lines.length <= maxLines) {
			return code;
		}

		// Keep first and last portions
		const keepStart = Math.floor(maxLines * 0.6);
		const keepEnd = Math.floor(maxLines * 0.3);
		const omitted = lines.length - keepStart - keepEnd;

		return [
			...lines.slice(0, keepStart),
			`  // ... ${omitted} lines omitted ...`,
			...lines.slice(-keepEnd),
		].join("\n");
	}

	/**
	 * Extract properties from class code (simplified regex approach)
	 */
	private extractProperties(
		code: string,
		language: string,
	): Array<{ name: string; type?: string; visibility?: string }> {
		const properties: Array<{
			name: string;
			type?: string;
			visibility?: string;
		}> = [];

		if (language === "typescript" || language === "javascript") {
			// Match property declarations like: private readonly name: Type
			const propRegex =
				/(private|public|protected|readonly)?\s*(readonly)?\s*(\w+)\s*[?!]?\s*:\s*([^;=]+)/g;
			let match;
			while ((match = propRegex.exec(code)) !== null) {
				const visibility = match[1] || "public";
				const name = match[3];
				const type = match[4]?.trim();
				if (name && !name.startsWith("_") && name !== "constructor") {
					properties.push({ name, type, visibility });
				}
			}
		}

		return properties.slice(0, 10); // Limit to first 10
	}

	/**
	 * Clear the summary cache
	 */
	clearCache(): void {
		this.summaryCache.clear();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a bottom-up summarizer
 */
export function createBottomUpSummarizer(
	llmClient: ILLMClient,
	store: VectorStore,
): BottomUpSummarizer {
	return new BottomUpSummarizer(llmClient, store);
}
