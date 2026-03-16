/**
 * Enricher
 *
 * Main orchestrator for the enrichment process.
 * Coordinates pipeline, embedding, and storage of enriched documents.
 */

import type {
	BaseDocument,
	CodeChunk,
	DocumentType,
	DocumentWithEmbedding,
	EnrichmentProgressCallback,
	EnrichmentResult,
	IEmbeddingsClient,
	ILLMClient,
} from "../../types.js";
import type { IVectorStore } from "../store.js";
import type { IFileTracker } from "../tracker.js";
import {
	createDefaultExtractors,
	createExtractorRegistry,
	ExtractorRegistry,
	FileSummaryExtractor,
} from "./extractors/index.js";
import { createEnrichmentPipeline, EnrichmentPipeline } from "./pipeline.js";
import {
	createRefinementEngine,
	createRetrievalStrategy,
	type RefinementContext,
	type IterativeRefinementResults,
	calculateRefinementScore,
} from "./refinement/index.js";

// ============================================================================
// Types
// ============================================================================

export interface EnricherOptions {
	/** Document types to extract (default: all) */
	documentTypes?: DocumentType[];
	/** Progress callback */
	onProgress?: EnrichmentProgressCallback;
	/** Skip embedding (for testing) */
	skipEmbedding?: boolean;
	/** Maximum concurrent file enrichments (default: 3) */
	concurrency?: number;
}

export interface FileToEnrich {
	filePath: string;
	fileContent: string;
	codeChunks: CodeChunk[];
	language: string;
}

export interface RefinementOptions {
	/** Target rank threshold - summaries ranking above this are refined (default: 3) */
	targetRank?: number;
	/** Maximum refinement rounds per summary (default: 3) */
	maxRounds?: number;
	/** Concurrency for parallel refinement (default: 5) */
	concurrency?: number;
	/** Progress callback for refinement progress */
	onProgress?: (
		phase: string,
		completed: number,
		total: number,
		details?: string,
	) => void;
}

export interface RefinementResult {
	/** Number of summaries tested */
	totalTested: number;
	/** Number of summaries that failed quality test */
	failuresFound: number;
	/** Number of summaries successfully refined */
	successfullyRefined: number;
	/** Average rounds needed for successful refinement */
	avgRoundsToSuccess: number;
	/** Average Brokk-style score (1.0 / log2(rounds + 2)) */
	avgRefinementScore: number;
	/** Duration in milliseconds */
	durationMs: number;
	/** Individual refinement results */
	details: Array<{
		documentId: string;
		filePath?: string;
		documentType: DocumentType;
		initialRank: number;
		finalRank: number;
		rounds: number;
		success: boolean;
		refinementScore: number;
	}>;
}

// ============================================================================
// Enricher Class
// ============================================================================

export class Enricher {
	private llmClient: ILLMClient;
	private embeddingsClient: IEmbeddingsClient;
	private vectorStore: IVectorStore;
	private tracker: IFileTracker;
	private pipeline: EnrichmentPipeline;
	private registry: ExtractorRegistry;

	constructor(
		llmClient: ILLMClient,
		embeddingsClient: IEmbeddingsClient,
		vectorStore: IVectorStore,
		tracker: IFileTracker,
	) {
		this.llmClient = llmClient;
		this.embeddingsClient = embeddingsClient;
		this.vectorStore = vectorStore;
		this.tracker = tracker;

		// Create registry and register extractors
		this.registry = createExtractorRegistry();
		this.registerDefaultExtractors();

		// Create pipeline
		this.pipeline = createEnrichmentPipeline(this.registry, llmClient);
	}

	/**
	 * Register default extractors.
	 */
	private registerDefaultExtractors(): void {
		const extractors = createDefaultExtractors();
		for (const extractor of extractors) {
			this.registry.register(extractor);
		}
	}

	/**
	 * Register a custom extractor
	 */
	registerExtractor(extractor: any): void {
		this.registry.register(extractor);
	}

	/**
	 * Enrich a single file
	 */
	async enrichFile(
		file: FileToEnrich,
		options: EnricherOptions = {},
	): Promise<EnrichmentResult> {
		const startTime = Date.now();
		let documentsCreated = 0;
		let documentsUpdated = 0;
		const errors: EnrichmentResult["errors"] = [];

		try {
			// Load existing docs for this file to enable true incremental enrichment
			// (extractors can skip if content unchanged)
			const existingDocs = await this.vectorStore.getDocumentsByFile(
				file.filePath,
				options.documentTypes,
			);

			// Extract documents using pipeline
			const pipelineResult = await this.pipeline.extractFile(
				file.filePath,
				file.fileContent,
				file.codeChunks,
				file.language,
				{
					documentTypes: options.documentTypes,
					onProgress: options.onProgress,
					existingDocs,
				},
			);

			// Transform pipeline errors to enrichment result format
			for (const err of pipelineResult.errors) {
				errors.push({
					file: err.filePath,
					documentType: err.documentType,
					error: err.error,
				});
			}

			if (pipelineResult.documents.length === 0) {
				return {
					documentsCreated: 0,
					documentsUpdated: 0,
					durationMs: Date.now() - startTime,
					errors,
				};
			}

			// Embed documents
			let documentsWithEmbeddings: DocumentWithEmbedding[];

			if (options.skipEmbedding) {
				// For testing - use zero vectors
				documentsWithEmbeddings = pipelineResult.documents.map((doc) => ({
					...doc,
					vector: new Array(384).fill(0),
				}));
			} else {
				documentsWithEmbeddings = await this.embedDocuments(
					pipelineResult.documents,
				);
			}

			// Store documents
			await this.vectorStore.addDocuments(documentsWithEmbeddings);

			// Track documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || file.filePath,
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));

			this.tracker.trackDocuments(trackedDocs);

			// Update enrichment state
			const completedTypes = new Set(
				pipelineResult.documents.map((d) => d.documentType),
			);
			for (const docType of completedTypes) {
				this.tracker.setEnrichmentState(file.filePath, docType, "complete");
			}

			documentsCreated = pipelineResult.documents.length;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			errors.push({
				file: file.filePath,
				documentType: "file_summary",
				error: errorMessage,
			});
		}

		return {
			documentsCreated,
			documentsUpdated,
			durationMs: Date.now() - startTime,
			errors,
		};
	}

	/**
	 * Enrich multiple files using batched LLM calls for efficiency.
	 * Processes file summaries AND symbol summaries in parallel for maximum throughput.
	 */
	async enrichFiles(
		files: FileToEnrich[],
		options: EnricherOptions = {},
	): Promise<EnrichmentResult> {
		const startTime = Date.now();
		const total = files.length;

		let totalCreated = 0;
		let totalUpdated = 0;
		const allErrors: EnrichmentResult["errors"] = [];

		// Cost and call tracking per phase
		let fileSummariesCost = 0;
		let symbolSummariesCost = 0;
		let fileSummariesCalls = 0;
		let symbolSummariesCalls = 0;

		// Get LLM provider label for display
		const provider = this.llmClient.getProvider();
		const providerLabel =
			provider === "claude-code"
				? "Claude CLI"
				: provider === "anthropic"
					? "Anthropic API"
					: provider === "openrouter"
						? "OpenRouter"
						: provider === "local"
							? "Local LLM"
							: provider;

		// Report progress helper - phase is used by CLI to show distinct progress bars
		const reportProgress = (
			phase: string,
			completed: number,
			phaseTotal: number,
			status: string,
			inProgress = 0,
		) => {
			if (options.onProgress) {
				// Format: "[phase] status" - CLI parses this to show separate progress lines
				options.onProgress(
					completed,
					phaseTotal,
					phase as DocumentType,
					status,
					inProgress,
				);
			}
		};

		// Thread-safe document accumulation (JS is single-threaded for sync ops)
		const fileSummaryDocs: BaseDocument[] = [];
		const symbolSummaryDocs: BaseDocument[] = [];
		// Cloud providers handle higher concurrency; local LLMs are single-threaded
		const defaultConcurrency = provider === "local" ? 3 : 15;
		const concurrency = options.concurrency ?? defaultConcurrency;

		// File summary extractor
		const fileSummaryExtractor = this.registry.get("file_summary") as
			| FileSummaryExtractor
			| undefined;
		const otherTypes: DocumentType[] = ["symbol_summary"];

		// Reset usage tracking
		this.llmClient.resetAccumulatedUsage();

		// ============================================================================
		// PARALLEL PHASE: File summaries + Symbol summaries run concurrently
		// Each reports to its own progress line (CLI handles parallel phases)
		// ============================================================================

		// File summaries processor
		const processFileSummaries = async (): Promise<void> => {
			if (!fileSummaryExtractor) return;

			let completed = 0;
			const inProgress = new Set<string>();

			const processFile = async (file: FileToEnrich): Promise<void> => {
				const fileName = file.filePath.split("/").pop() || file.filePath;
				inProgress.add(fileName);

				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 2).join(", ");
				const moreCount = active > 2 ? ` +${active - 2}` : "";
				reportProgress(
					"file summaries",
					completed,
					total,
					`${completed}/${total} (${active} active) ${activeList}${moreCount}`,
					active,
				);

				try {
					const docs = await fileSummaryExtractor.extract(
						{
							filePath: file.filePath,
							fileContent: file.fileContent,
							language: file.language,
							codeChunks: file.codeChunks,
							projectPath: "",
						},
						this.llmClient,
					);

					fileSummaryDocs.push(...docs);

					for (const doc of docs) {
						if (doc.filePath) {
							this.tracker.setEnrichmentState(
								doc.filePath,
								"file_summary",
								"complete",
							);
						}
					}
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					allErrors.push({
						file: file.filePath,
						documentType: "file_summary",
						error: errorMessage,
					});
				} finally {
					inProgress.delete(fileName);
					completed++;
				}
			};

			reportProgress("file summaries", 0, total, `0/${total} starting...`, 0);

			await runWithPool(files, concurrency, processFile);

			reportProgress(
				"file summaries",
				total,
				total,
				`${total}/${total} via ${providerLabel}`,
				0,
			);
		};

		// Symbol summaries processor
		const processSymbolSummaries = async (): Promise<void> => {
			if (otherTypes.length === 0) return;

			let completed = 0;
			const inProgress = new Set<string>();

			const processFile = async (file: FileToEnrich): Promise<void> => {
				const fileName = file.filePath.split("/").pop() || file.filePath;
				inProgress.add(fileName);

				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 2).join(", ");
				const moreCount = active > 2 ? ` +${active - 2}` : "";
				reportProgress(
					"symbol summaries",
					completed,
					total,
					`${completed}/${total} (${active} active) ${activeList}${moreCount}`,
					active,
				);

				try {
					const pipelineResult = await this.pipeline.extractFile(
						file.filePath,
						file.fileContent,
						file.codeChunks,
						file.language,
						{
							documentTypes: otherTypes,
							existingDocs: [], // No dependency on file summaries
						},
					);

					symbolSummaryDocs.push(...pipelineResult.documents);

					for (const err of pipelineResult.errors) {
						allErrors.push({
							file: err.filePath,
							documentType: err.documentType,
							error: err.error,
						});
					}
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					allErrors.push({
						file: file.filePath,
						documentType: "symbol_summary",
						error: errorMessage,
					});
				} finally {
					inProgress.delete(fileName);
					completed++;
				}
			};

			reportProgress("symbol summaries", 0, total, `0/${total} starting...`, 0);

			await runWithPool(files, concurrency, processFile);

			reportProgress(
				"symbol summaries",
				total,
				total,
				`${total}/${total} done`,
				0,
			);
		};

		// Run BOTH phases in parallel - this doubles throughput when using cloud LLM!
		await Promise.all([processFileSummaries(), processSymbolSummaries()]);

		// Combine all documents
		const allDocuments = [...fileSummaryDocs, ...symbolSummaryDocs];

		// Get combined usage
		const combinedUsage = this.llmClient.getAccumulatedUsage();
		const fileSummaryRatio =
			fileSummaryDocs.length / Math.max(1, allDocuments.length);
		fileSummariesCost = combinedUsage.cost * fileSummaryRatio;
		symbolSummariesCost = combinedUsage.cost * (1 - fileSummaryRatio);
		fileSummariesCalls = Math.round(combinedUsage.calls * fileSummaryRatio);
		symbolSummariesCalls = combinedUsage.calls - fileSummariesCalls;

		// Step 3: Embed all documents in batch
		const docCount = allDocuments.length;
		if (docCount > 0) {
			reportProgress(
				"embed summaries",
				0,
				docCount,
				`${docCount} documents...`,
				docCount,
			);

			let documentsWithEmbeddings: DocumentWithEmbedding[];
			if (options.skipEmbedding) {
				documentsWithEmbeddings = allDocuments.map((doc) => ({
					...doc,
					vector: new Array(384).fill(0),
				}));
			} else {
				documentsWithEmbeddings = await this.embedDocuments(allDocuments);
			}

			reportProgress(
				"embed summaries",
				docCount,
				docCount,
				`${docCount} embedded`,
				0,
			);

			// Step 4: Store all documents
			reportProgress(
				"store vectors",
				0,
				docCount,
				`${docCount} documents...`,
				docCount,
			);
			await this.vectorStore.addDocuments(documentsWithEmbeddings);

			// Track all documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || "",
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));
			this.tracker.trackDocuments(trackedDocs);

			totalCreated = allDocuments.length;
			reportProgress(
				"store vectors",
				docCount,
				docCount,
				`${docCount} stored`,
				0,
			);
		}

		// Calculate totals
		const totalCost = fileSummariesCost + symbolSummariesCost;
		const totalCalls = fileSummariesCalls + symbolSummariesCalls;

		return {
			documentsCreated: totalCreated,
			documentsUpdated: totalUpdated,
			durationMs: Date.now() - startTime,
			errors: allErrors,
			llmProvider: provider,
			cost: totalCost > 0 ? totalCost : undefined,
			costBreakdown:
				totalCost > 0
					? {
							fileSummaries:
								fileSummariesCost > 0 ? fileSummariesCost : undefined,
							symbolSummaries:
								symbolSummariesCost > 0 ? symbolSummariesCost : undefined,
						}
					: undefined,
			llmCalls:
				totalCalls > 0
					? {
							fileSummaries: fileSummariesCalls,
							symbolSummaries: symbolSummariesCalls,
							total: totalCalls,
						}
					: undefined,
		};
	}

	/**
	 * Embed documents using the embeddings client
	 */
	private async embedDocuments(
		documents: BaseDocument[],
	): Promise<DocumentWithEmbedding[]> {
		if (documents.length === 0) {
			return [];
		}

		// Extract content for embedding
		const contents = documents.map((doc) => doc.content);

		// Generate embeddings
		const result = await this.embeddingsClient.embed(contents);

		// Combine documents with embeddings
		return documents.map((doc, i) => ({
			...doc,
			vector: result.embeddings[i],
		}));
	}

	/**
	 * Get the extraction order for document types
	 */
	getExtractionOrder(types: DocumentType[]): DocumentType[] {
		return this.pipeline.getExtractionOrder(types);
	}

	/**
	 * Check if a file needs enrichment
	 */
	needsEnrichment(filePath: string, documentType: DocumentType): boolean {
		return this.tracker.needsEnrichment(filePath, documentType);
	}

	/**
	 * Get files that need enrichment for a document type
	 */
	getFilesNeedingEnrichment(documentType: DocumentType): string[] {
		return this.tracker.getFilesNeedingEnrichment(documentType);
	}

	// ========================================================================
	// Iterative Refinement
	// ========================================================================

	/**
	 * Refine summaries that fail quality testing.
	 *
	 * Uses retrieval-based quality testing to identify poor summaries,
	 * then iteratively refines them using LLM feedback.
	 *
	 * Inspired by Brokk's edit-test loop methodology.
	 *
	 * @example
	 * ```typescript
	 * const result = await enricher.refineFailures({
	 *   targetRank: 3,
	 *   maxRounds: 3,
	 *   onProgress: (phase, completed, total, details) => {
	 *     console.log(`[${phase}] ${completed}/${total}: ${details}`);
	 *   },
	 * });
	 *
	 * console.log(`Refined ${result.successfullyRefined} of ${result.failuresFound} failures`);
	 * ```
	 */
	async refineFailures(
		options: RefinementOptions = {},
	): Promise<RefinementResult> {
		const startTime = Date.now();
		const {
			targetRank = 3,
			maxRounds = 3,
			concurrency = 5,
			onProgress,
		} = options;

		const reportProgress = (
			phase: string,
			completed: number,
			total: number,
			details?: string,
		) => {
			if (onProgress) {
				onProgress(phase, completed, total, details);
			}
		};

		// Step 1: Get all summaries from vector store
		reportProgress("loading", 0, 0, "Loading summaries from index...");
		const allSummaries = await this.vectorStore.getAllSummaries();

		if (allSummaries.length === 0) {
			return {
				totalTested: 0,
				failuresFound: 0,
				successfullyRefined: 0,
				avgRoundsToSuccess: 0,
				avgRefinementScore: 0,
				durationMs: Date.now() - startTime,
				details: [],
			};
		}

		reportProgress(
			"loading",
			allSummaries.length,
			allSummaries.length,
			`Loaded ${allSummaries.length} summaries`,
		);

		// Step 2: Create refinement engine and strategy
		const engine = createRefinementEngine();
		const strategy = createRetrievalStrategy({
			embeddingsClient: this.embeddingsClient,
			targetRank,
		});

		// Step 3: Test all summaries and collect failures
		reportProgress(
			"testing",
			0,
			allSummaries.length,
			"Testing summary quality...",
		);

		const failures: Array<{
			summary: (typeof allSummaries)[0];
			initialRank: number;
		}> = [];

		let tested = 0;
		for (let i = 0; i < allSummaries.length; i += concurrency) {
			const batch = allSummaries.slice(i, i + concurrency);

			await Promise.all(
				batch.map(async (summary) => {
					// Build minimal refinement context for testing
					const context: RefinementContext = {
						summary: summary.content,
						codeContent: "", // Not needed for testing, only for refinement prompt
						language: "",
						metadata: {
							filePath: summary.filePath,
						},
						competitors: allSummaries
							.filter((s) => s.id !== summary.id)
							.slice(0, 20) // Sample competitors for efficiency
							.map((s) => ({
								summary: s.content,
								modelId: "index",
							})),
					};

					// Test quality
					const result = await strategy.testQuality(summary.content, context);
					tested++;

					if (!strategy.isSuccess(result)) {
						failures.push({
							summary,
							initialRank: result.rank ?? Infinity,
						});
					}

					reportProgress(
						"testing",
						tested,
						allSummaries.length,
						`Tested ${tested}/${allSummaries.length}, ${failures.length} failures`,
					);
				}),
			);
		}

		if (failures.length === 0) {
			return {
				totalTested: allSummaries.length,
				failuresFound: 0,
				successfullyRefined: 0,
				avgRoundsToSuccess: 0,
				avgRefinementScore: 1.0, // All passed on first try
				durationMs: Date.now() - startTime,
				details: [],
			};
		}

		// Step 4: Refine failures
		reportProgress(
			"refining",
			0,
			failures.length,
			`Refining ${failures.length} failing summaries...`,
		);

		const results: RefinementResult["details"] = [];
		let refined = 0;
		let successCount = 0;
		let roundsSum = 0;
		let scoreSum = 0;

		// We need code content for refinement - read from source if available
		for (let i = 0; i < failures.length; i += concurrency) {
			const batch = failures.slice(i, i + concurrency);

			await Promise.all(
				batch.map(async (failure) => {
					const summary = failure.summary;

					// Build full refinement context
					const context: RefinementContext = {
						summary: summary.content,
						codeContent: "", // We don't have original code in production - refinement will use summary context
						language: "",
						metadata: {
							filePath: summary.filePath,
						},
						competitors: allSummaries
							.filter((s) => s.id !== summary.id)
							.slice(0, 20)
							.map((s) => ({
								summary: s.content,
								modelId: "index",
							})),
					};

					try {
						// Run refinement
						const refinementResult = await engine.refine(
							summary.content,
							context,
							{
								maxRounds,
								strategy,
								llmClient: this.llmClient,
							},
						);

						// Track stats
						const score = calculateRefinementScore(refinementResult.rounds);

						if (refinementResult.success) {
							successCount++;
							roundsSum += refinementResult.rounds;

							// Update the summary in the vector store
							if (refinementResult.rounds > 0) {
								// Re-embed the refined summary
								const embedResult = await this.embeddingsClient.embed([
									refinementResult.finalSummary,
								]);
								const newVector = embedResult.embeddings[0];

								await this.vectorStore.updateDocumentContent(
									summary.id,
									refinementResult.finalSummary,
									newVector,
								);
							}
						}

						scoreSum += score;

						results.push({
							documentId: summary.id,
							filePath: summary.filePath,
							documentType: summary.documentType,
							initialRank: failure.initialRank,
							finalRank:
								refinementResult.metrics.finalRank ?? failure.initialRank,
							rounds: refinementResult.rounds,
							success: refinementResult.success,
							refinementScore: score,
						});
					} catch (error) {
						// Record failure
						results.push({
							documentId: summary.id,
							filePath: summary.filePath,
							documentType: summary.documentType,
							initialRank: failure.initialRank,
							finalRank: failure.initialRank,
							rounds: 0,
							success: false,
							refinementScore: 0,
						});
					}

					refined++;
					reportProgress(
						"refining",
						refined,
						failures.length,
						`Refined ${refined}/${failures.length}`,
					);
				}),
			);
		}

		reportProgress(
			"complete",
			failures.length,
			failures.length,
			`Done: ${successCount}/${failures.length} successfully refined`,
		);

		return {
			totalTested: allSummaries.length,
			failuresFound: failures.length,
			successfullyRefined: successCount,
			avgRoundsToSuccess: successCount > 0 ? roundsSum / successCount : 0,
			avgRefinementScore:
				failures.length > 0 ? scoreSum / failures.length : 1.0,
			durationMs: Date.now() - startTime,
			details: results,
		};
	}
}

// ============================================================================
// Concurrency Pool
// ============================================================================

/**
 * Run async tasks with a concurrency pool (no straggler blocking).
 *
 * Unlike batch-and-wait (`for i += N; Promise.all(batch)`), this starts
 * a new task as soon as any slot frees up. A single slow file no longer
 * blocks N-1 idle slots.
 */
async function runWithPool<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let idx = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (idx < items.length) {
				const i = idx++;
				await fn(items[i]);
			}
		},
	);
	await Promise.all(workers);
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enricher
 */
export function createEnricher(
	llmClient: ILLMClient,
	embeddingsClient: IEmbeddingsClient,
	vectorStore: IVectorStore,
	tracker: IFileTracker,
): Enricher {
	return new Enricher(llmClient, embeddingsClient, vectorStore, tracker);
}
