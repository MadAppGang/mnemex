/**
 * Enrichment Pipeline
 *
 * Orchestrates the extraction of documents from code chunks.
 * Handles dependency ordering and parallel execution where possible.
 */

import type {
	BaseDocument,
	CodeChunk,
	Document,
	DocumentType,
	EnrichmentProgressCallback,
	ExtractionContext,
	IDocumentExtractor,
	ILLMClient,
} from "../../types.js";
import { DependencyGraph, createDependencyGraph } from "./dependency-graph.js";
import { ExtractorRegistry } from "./extractors/base.js";

// ============================================================================
// Types
// ============================================================================

export interface PipelineOptions {
	/** Document types to extract (default: all registered) */
	documentTypes?: DocumentType[];
	/** Progress callback */
	onProgress?: EnrichmentProgressCallback;
	/** Maximum concurrent extractions per type */
	concurrency?: number;
	/** Existing docs for this file (enables true incremental - skip unchanged) */
	existingDocs?: BaseDocument[];
}

export interface PipelineResult {
	/** Documents extracted */
	documents: BaseDocument[];
	/** Errors encountered */
	errors: Array<{
		documentType: DocumentType;
		filePath: string;
		error: string;
	}>;
	/** Time taken in milliseconds */
	durationMs: number;
}

// ============================================================================
// Enrichment Pipeline Class
// ============================================================================

export class EnrichmentPipeline {
	private registry: ExtractorRegistry;
	private dependencyGraph: DependencyGraph;
	private llmClient: ILLMClient;

	constructor(
		registry: ExtractorRegistry,
		llmClient: ILLMClient,
		customDeps?: Partial<Record<DocumentType, DocumentType[]>>,
	) {
		this.registry = registry;
		this.llmClient = llmClient;
		this.dependencyGraph = createDependencyGraph(customDeps);
	}

	/**
	 * Extract documents from code chunks for a single file
	 */
	async extractFile(
		filePath: string,
		fileContent: string,
		codeChunks: CodeChunk[],
		language: string,
		options: PipelineOptions = {},
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const documents: BaseDocument[] = [];
		const errors: PipelineResult["errors"] = [];

		// Determine which types to extract
		const targetTypes = options.documentTypes || this.registry.getTypes();

		// Filter out code_chunk since that's handled by the chunker
		const extractionTypes = targetTypes.filter((t) => t !== "code_chunk");

		// Get extraction order based on dependencies
		const orderedTypes =
			this.dependencyGraph.getExtractionOrder(extractionTypes);

		// Build extraction context with existing docs for incremental processing
		const context: ExtractionContext = {
			projectPath: "", // Will be set by caller
			codeChunks,
			filePath,
			fileContent,
			language,
			existingDocs: options.existingDocs || [],
		};

		// Track completed types for this file
		const completedTypes = new Set<DocumentType>(["code_chunk"]);

		// Extract in dependency order
		for (const docType of orderedTypes) {
			const extractor = this.registry.get(docType);
			if (!extractor) {
				continue;
			}

			// Check if dependencies are satisfied
			if (
				!this.dependencyGraph.areDependenciesSatisfied(docType, completedTypes)
			) {
				errors.push({
					documentType: docType,
					filePath,
					error: `Dependencies not satisfied for ${docType}`,
				});
				continue;
			}

			try {
				// Report progress
				if (options.onProgress) {
					const completed = completedTypes.size;
					const total = orderedTypes.length + 1; // +1 for code_chunk
					options.onProgress(completed, total, docType, filePath);
				}

				// Check if extraction is needed
				if (!extractor.needsUpdate(context)) {
					completedTypes.add(docType);
					continue;
				}

				// Extract documents
				const extracted = await extractor.extract(context, this.llmClient);
				documents.push(...extracted);

				// Update context with extracted docs for dependent extractors
				context.existingDocs = [...(context.existingDocs || []), ...extracted];

				completedTypes.add(docType);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				errors.push({
					documentType: docType,
					filePath,
					error: errorMessage,
				});
			}
		}

		return {
			documents,
			errors,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Extract documents from multiple files
	 */
	async extractFiles(
		files: Array<{
			filePath: string;
			fileContent: string;
			codeChunks: CodeChunk[];
			language: string;
		}>,
		options: PipelineOptions = {},
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const allDocuments: BaseDocument[] = [];
		const allErrors: PipelineResult["errors"] = [];

		let processed = 0;
		const total = files.length;

		for (const file of files) {
			const result = await this.extractFile(
				file.filePath,
				file.fileContent,
				file.codeChunks,
				file.language,
				{
					...options,
					onProgress: options.onProgress
						? (completed, fileTotal, docType, filePath) => {
								// Scale progress to overall progress
								const fileProgress = completed / fileTotal;
								const overallProgress = (processed + fileProgress) / total;
								options.onProgress!(
									Math.floor(overallProgress * 100),
									100,
									docType,
									filePath,
								);
							}
						: undefined,
				},
			);

			allDocuments.push(...result.documents);
			allErrors.push(...result.errors);
			processed++;
		}

		return {
			documents: allDocuments,
			errors: allErrors,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Get the extraction order for given document types
	 */
	getExtractionOrder(types: DocumentType[]): DocumentType[] {
		return this.dependencyGraph.getExtractionOrder(types);
	}

	/**
	 * Get types affected by a change to the given type
	 */
	getAffectedTypes(changedType: DocumentType): DocumentType[] {
		return this.dependencyGraph.getAffectedTypes(changedType);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enrichment pipeline
 */
export function createEnrichmentPipeline(
	registry: ExtractorRegistry,
	llmClient: ILLMClient,
	customDeps?: Partial<Record<DocumentType, DocumentType[]>>,
): EnrichmentPipeline {
	return new EnrichmentPipeline(registry, llmClient, customDeps);
}
