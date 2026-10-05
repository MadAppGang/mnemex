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
	EnrichmentReuse,
	EnrichmentState,
	IEmbeddingsClient,
	ILLMClient,
} from "../../types.js";
import { batchIds, narrowIds, WRITE_CHUNK } from "../branch-membership.js";
import { scopeForBranchId } from "../branch-scope.js";
import type { IVectorStore, RowMembership } from "../store.js";
import { yieldToEventLoop } from "../sync-region.js";
import {
	computeHash,
	type EnrichmentContentKey,
	type EnrichmentRecord,
	enrichmentContentKeyId,
	type IFileTracker,
	type TrackedDocument,
} from "../tracker.js";
import {
	createDefaultExtractors,
	createExtractorRegistry,
	type ExtractorRegistry,
	type FileSummaryExtractor,
} from "./extractors/index.js";
import {
	createEnrichmentPipeline,
	type EnrichmentPipeline,
} from "./pipeline.js";
import {
	calculateRefinementScore,
	createRefinementEngine,
	createRetrievalStrategy,
	type RefinementContext,
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
	/**
	 * The membership of every document written (architecture §3.2.1). Summaries
	 * are a function of the tree, so the caller passes `"repo"` under its run's
	 * branch id. Required, with no default: a default would have to be `,0,`,
	 * which makes a branch's summaries visible from every branch.
	 */
	membership: RowMembership;
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
// Enrichment reuse by CONTENT — architecture §4.6, decision I-15
// ============================================================================

/**
 * THE POLICY, AND THE ONE THING IT DELIBERATELY DOES NOT KEY ON.
 *
 * §4.6 exists because the first index of every branch re-enriched the whole
 * tree — "a real LLM bill, invisible to V3.1, which counts embeddings only".
 * The reuse key is `(path_kind, path, content_hash)`: every input the summary
 * text is a function of, because the path reaches the LLM prompt
 * (`buildFileSummaryPrompt`), the stored summary text (`buildContent`) and the
 * summary's own id (`generateId`). CLAUDE.md #31's third bullet is the rule
 * being followed — a transform below the seam that the key cannot see is a
 * corrupt-cache generator, so the key covers the whole input.
 *
 * THE PRODUCER (`provider/model`) IS RECORDED AND NOT KEYED ON, and that is a
 * decision rather than an oversight:
 *
 *   - Today, `files.enrichment_state` says `complete` forever. Switching
 *     `MNEMEX_LLM` does NOT re-enrich anything on a branch that is already
 *     enriched — an unchanged file is not re-chunked, so it never reaches the
 *     enricher at all. Keying on the producer would make the FIRST index of a
 *     second branch re-enrich the whole tree after any model change, which is
 *     precisely the bill §4.6 exists to remove, triggered by a setting the
 *     user may not remember changing.
 *   - Not keying on it makes the store SELF-CONSISTENT: every branch sees the
 *     same summary for the same content, rather than branch A's rows coming
 *     from model X and branch B's from model Y for identical text.
 *   - So the reuse rule is exactly today's rule, extended along the dimension
 *     §4.6 is about (branch), and no new staleness is introduced. The column
 *     is written anyway so the decision can be REVISITED from data rather than
 *     from a schema change: `SELECT DISTINCT producer FROM
 *     enrichment_by_content` answers "was this index built by one model?".
 *
 * Reported to the orchestrator as an open decision, not settled here.
 */
export function enrichmentProducer(llmClient: ILLMClient): string {
	return `${llmClient.getProvider()}/${llmClient.getModel()}`;
}

/** One file's reuse decision (§4.6). */
interface ReuseDecision {
	file: FileToEnrich;
	key: EnrichmentContentKey;
	/** The records this file may adopt, when it may adopt at all. */
	records: EnrichmentRecord[];
	/**
	 * Why this file is NOT reused. `null` means it is.
	 *
	 * A reuse path that cannot say it did not reuse is indistinguishable from
	 * one broken in the expensive direction — the lesson CLAUDE.md #31's
	 * deleted seed left behind, where a cheerful message covered an index built
	 * out of placeholders.
	 */
	refusedBecause: "no-record" | "incomplete" | "row-missing" | null;
}

/**
 * `newIds` per file for NARROW_SUMMARIES. A document with no `filePath` is a
 * project-level one and is not tree-scoped by path, so it is left out — its
 * narrow would have no work list to derive.
 */
function summaryIdsByFile(
	documents: ReadonlyArray<{ id: string; filePath?: string }>,
): Map<string, Set<string>> {
	const byFile = new Map<string, Set<string>>();
	for (const doc of documents) {
		const filePath = doc.filePath ?? "";
		if (filePath === "") continue;
		const ids = byFile.get(filePath);
		if (ids === undefined) byFile.set(filePath, new Set([doc.id]));
		else ids.add(doc.id);
	}
	return byFile;
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
	 * Enrich a single file.
	 *
	 * NOT THE LIVE PATH, and it does NOT go through §4.6's reuse: the indexer
	 * calls `enrichFiles` and nothing in `src/` or `test/` calls this. It is
	 * left as it was rather than given a second, untested copy of the adoption
	 * logic — the same judgement 3b-2's finding 6 recorded about the three
	 * callerless unscoped deletes, whose answer was to retire them. Reported for
	 * the same decision here.
	 */
	async enrichFile(
		file: FileToEnrich,
		options: EnricherOptions,
	): Promise<EnrichmentResult> {
		const startTime = Date.now();
		let documentsCreated = 0;
		const documentsUpdated = 0;
		const errors: EnrichmentResult["errors"] = [];

		try {
			// Load existing docs for this file to enable true incremental enrichment
			// (extractors can skip if content unchanged)
			// The incremental check reads back only what THIS run's branch wrote:
			// another branch's summary for the same path is not evidence that this
			// branch's is current.
			const existingDocs = await this.vectorStore.getDocumentsByFile(
				scopeForBranchId(options.membership.branchId),
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

			// Store documents, under the branch model's journal (§4.1.4).
			await this.persistDocuments(documentsWithEmbeddings, options.membership);
			// NARROW_SUMMARIES for THIS file: its previous revision's summary ids
			// still point at this branch, and nothing else will ever collect them.
			await this.narrowSummaries(
				options.membership,
				new Map([
					[
						file.filePath,
						new Set(documentsWithEmbeddings.map((doc) => doc.id)),
					],
				]),
			);

			// Track documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || file.filePath,
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));

			this.tracker.trackDocuments(options.membership.branchId, trackedDocs);

			// Update enrichment state
			const completedTypes = new Set(
				pipelineResult.documents.map((d) => d.documentType),
			);
			for (const docType of completedTypes) {
				this.tracker.setEnrichmentState(
					options.membership.branchId,
					file.filePath,
					docType,
					"complete",
				);
				// SR-2. Found by the caller-side sweep the moment it could SEE
				// this file at all (phase 3b-4): every region-driving loop here
				// was invisible to it, because it recognised a tracker handle by
				// the NAME `this.fileTracker` and this class calls its own
				// `this.tracker`.
				await yieldToEventLoop();
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
		allFiles: FileToEnrich[],
		options: EnricherOptions,
	): Promise<EnrichmentResult> {
		const startTime = Date.now();

		let totalCreated = 0;
		const totalUpdated = 0;
		const allErrors: EnrichmentResult["errors"] = [];

		// ── §4.6: reuse by content, BEFORE any producer runs ─────────────────
		//
		// The saving is the whole point of this phase, and the shape of it is
		// this: on a second worktree every file is NEW for that branch, so every
		// file reaches this method, and before §4.6 every one of them was sent to
		// the LLM again. The decision is per file and it is recorded as data.
		const decisions = await this.planReuse(allFiles, options.membership);
		const adoptions = decisions.filter((d) => d.refusedBecause === null);
		const toEnrich = decisions.filter((d) => d.refusedBecause !== null);
		const documentsReused = await this.adoptEnrichment(
			adoptions,
			options.membership,
		);
		const reuse: EnrichmentReuse = {
			filesReused: adoptions.length,
			documentsReused,
			filesEnriched: toEnrich.length,
			filesRefused: decisions.filter((d) => d.refusedBecause === "row-missing")
				.length,
		};
		const files = toEnrich.map((decision) => decision.file);
		const total = files.length;

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
								options.membership.branchId,
								doc.filePath,
								"file_summary",
								"complete",
							);
							// SR-2, as in `enrichFile` above: one region per
							// document, and `concurrency` of these loops run at
							// once, so the event loop has to be able to reach its
							// timers phase between two of them.
							await yieldToEventLoop();
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

					// The state this pass EARNED. It used to be written for
					// `file_summary` only (a few lines up) and never for the type
					// this loop produces, which was inert while nothing read
					// `symbol_summary` state — and stopped being inert in phase
					// 3b-4: §4.6's adoption writes the state for every type the
					// record names, so a branch that ADOPTED a file would have
					// carried `symbol_summary: complete` while the branch that
					// PAID for it did not. Two branches with identical content in
					// different states is the defect this whole build is about, so
					// the two paths are made to agree here rather than in the
					// adopting half.
					for (const doc of pipelineResult.documents) {
						if (!doc.filePath) continue;
						this.tracker.setEnrichmentState(
							options.membership.branchId,
							doc.filePath,
							doc.documentType,
							"complete",
						);
						await yieldToEventLoop();
					}

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
			await this.persistDocuments(documentsWithEmbeddings, options.membership);
			await this.narrowSummaries(
				options.membership,
				summaryIdsByFile(documentsWithEmbeddings),
			);

			// Track all documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || "",
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));
			this.tracker.trackDocuments(options.membership.branchId, trackedDocs);

			// §4.6's RECORD half, LAST: the rows are in LanceDB, registered in
			// `chunk_index` and in this branch's membership before anything is
			// remembered about them. A record written earlier would name a row a
			// crash could still take away — the shape CLAUDE.md #31's deleted
			// seeding pass shipped twice.
			await this.recordEnrichment(
				toEnrich,
				documentsWithEmbeddings,
				enrichmentProducer(this.llmClient),
			);

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
			// ALWAYS present, including all-zeros. A consumer comparing a reuse
			// run against a control has to be able to tell "nothing was reused"
			// from "this build has no reuse" — the same reason `embed_cache_tier`
			// is emitted even when the cache is off.
			reuse,
		};
	}

	/**
	 * §4.6, the READ half: which of these files this STORE has already
	 * enriched, whichever branch paid for it.
	 *
	 * THREE THINGS ARE CHECKED, and each one has to be, because the failure
	 * they prevent is silent:
	 *
	 *   1. a record exists for `(path, content)` — the key covers every input
	 *      the summary text depends on (see `enrichmentProducer`);
	 *   2. every record is `complete` — a `failed` or `pending` record is not
	 *      an enrichment, and adopting one would mark the branch done;
	 *   3. every summary id it names is REGISTERED (`chunk_index`) and LIVE
	 *      (`existingIds`). This is P1's belt (§4.1.1): WIDEN adds no row, so
	 *      widening an id whose row is gone would leave the branch pointing at
	 *      nothing while every counter said the reuse worked. A record that
	 *      fails this sends the file to the LLM — the reuse path saying, in
	 *      data, that it did not reuse.
	 */
	private async planReuse(
		files: FileToEnrich[],
		membership: RowMembership,
	): Promise<ReuseDecision[]> {
		const keys: EnrichmentContentKey[] = files.map((file) => ({
			pathKind: membership.pathKind,
			path: file.filePath,
			contentHash: computeHash(file.fileContent),
		}));
		// BATCHED, with a yield between batches, so the lookup for a
		// repository-sized queue is a series of one-statement regions rather than
		// one region holding N — the same shape `narrowIds` and the widen drain
		// use, and what keeps §5.3's per-region bound a bound (CLAUDE.md #20, #31).
		const byKey = new Map<string, EnrichmentRecord[]>();
		for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
			const batch = keys.slice(i, i + WRITE_CHUNK);
			for (const [id, records] of this.tracker.enrichmentByContent(batch)) {
				byKey.set(id, records);
			}
			await yieldToEventLoop();
		}

		const decisions: ReuseDecision[] = files.map((file, index) => {
			const key = keys[index];
			const records = byKey.get(enrichmentContentKeyId(key)) ?? [];
			if (records.length === 0) {
				return { file, key, records: [], refusedBecause: "no-record" };
			}
			if (records.some((record) => record.state !== "complete")) {
				return { file, key, records: [], refusedBecause: "incomplete" };
			}
			return { file, key, records, refusedBecause: null };
		});

		const candidateIds = [
			...new Set(
				decisions
					.filter((decision) => decision.refusedBecause === null)
					.flatMap((decision) =>
						decision.records.map((record) => record.summaryId),
					),
			),
		];
		if (candidateIds.length === 0) return decisions;

		// Both halves of P1, in the order the write path uses them: the tracker
		// says the row is REGISTERED, LanceDB says the row is THERE. Batched and
		// yielding, as above.
		const live = new Set<string>();
		for (const batch of batchIds(candidateIds, WRITE_CHUNK)) {
			const registered = this.tracker.knownChunkRows(batch);
			await yieldToEventLoop();
			for (const id of await this.vectorStore.existingIds([
				...registered.keys(),
			])) {
				live.add(id);
			}
			await yieldToEventLoop();
		}
		for (const decision of decisions) {
			if (decision.refusedBecause !== null) continue;
			const usable = decision.records.every((record) =>
				live.has(record.summaryId),
			);
			if (!usable) {
				decision.records = [];
				decision.refusedBecause = "row-missing";
			}
		}
		return decisions;
	}

	/**
	 * §4.6, the WRITE half: make summaries this store already holds VISIBLE
	 * from this branch, without an LLM call and without a new row.
	 *
	 * This is a WIDEN and nothing else (§4.1.3a): one `chunk_branches` row and
	 * one `'widen'` intent per id, exactly what a tier-1 chunk hit does. The
	 * mirror is rewritten by the run's drain from the id's WHOLE membership, so
	 * nothing here patches `branchIds`.
	 *
	 * It also writes the two per-branch facts a search needs and a widen does
	 * not carry: the `documents` row (branch-scoped, so branch A's cannot be
	 * read) and `files.enrichment_state`, which is what stops the next run
	 * queueing the file again. Adoption copies branch A's state for this
	 * content, which is §4.6's "identical content ⇒ identical summary" — no
	 * more and no less than the branch that paid for it has.
	 */
	private async adoptEnrichment(
		adoptions: readonly ReuseDecision[],
		membership: RowMembership,
	): Promise<number> {
		if (adoptions.length === 0) return 0;
		const branchId = membership.branchId;
		const ids = [
			...new Set(
				adoptions.flatMap((decision) =>
					decision.records.map((record) => record.summaryId),
				),
			),
		];
		// The `documents` row each id will get, built from the record that named
		// it. Built up front rather than looked up with a fallback inside the
		// batch loop: a fallback here would write a document row with an empty
		// `file_path`, which nothing could ever find again or narrow.
		const trackedById = new Map<string, TrackedDocument>();
		for (const decision of adoptions) {
			for (const record of decision.records) {
				trackedById.set(record.summaryId, {
					id: record.summaryId,
					documentType: record.documentType,
					filePath: decision.key.path,
					sourceIds: record.sourceIds,
					createdAt: record.createdAt ?? record.enrichedAt,
					enrichedAt: record.enrichedAt,
				});
			}
		}

		for (const batch of batchIds(ids, WRITE_CHUNK)) {
			// No `registered`: the `chunk_index` rows exist already — the run
			// that enriched this content wrote them, and `planReuse` has just
			// read them back. Re-registering would need the SUMMARY text's hash,
			// which adoption deliberately never loads.
			this.tracker.commitAddBatch(branchId, {
				registered: [],
				memberIds: batch,
				widenIds: batch,
				files: [],
				clearAddIntentIds: [],
			});
			await yieldToEventLoop();
			const documents: TrackedDocument[] = [];
			for (const id of batch) {
				const tracked = trackedById.get(id);
				if (tracked !== undefined) documents.push(tracked);
			}
			this.tracker.trackDocuments(branchId, documents);
			await yieldToEventLoop();
		}

		const adoptedIdsByFile = new Map<string, Set<string>>();
		for (const decision of adoptions) {
			const states = new Map<DocumentType, EnrichmentState>();
			const fileIds = adoptedIdsByFile.get(decision.key.path) ?? new Set();
			for (const record of decision.records) {
				states.set(record.documentType, record.state);
				fileIds.add(record.summaryId);
			}
			adoptedIdsByFile.set(decision.key.path, fileIds);
			for (const [documentType, state] of states) {
				this.tracker.setEnrichmentState(
					branchId,
					decision.key.path,
					documentType,
					state,
				);
				await yieldToEventLoop();
			}
		}

		// NARROW_SUMMARIES, for the same reason the enriched path runs it: this
		// branch may hold an EARLIER revision's summaries for these paths, whose
		// ids nothing else will ever collect.
		await this.narrowSummaries(membership, adoptedIdsByFile);
		return ids.length;
	}

	/**
	 * §4.6, the RECORD half: remember what a pass produced, so the next branch
	 * does not buy it again.
	 *
	 * Written AFTER the documents are in LanceDB and registered, never before:
	 * a record naming a row that does not exist is the failure mode CLAUDE.md
	 * #31's deleted seed shipped twice.
	 */
	private async recordEnrichment(
		enriched: readonly ReuseDecision[],
		documents: readonly DocumentWithEmbedding[],
		producer: string,
	): Promise<void> {
		if (enriched.length === 0 || documents.length === 0) return;
		const byPath = new Map<string, DocumentWithEmbedding[]>();
		for (const doc of documents) {
			const path = doc.filePath ?? "";
			if (path === "") continue;
			const list = byPath.get(path);
			if (list === undefined) byPath.set(path, [doc]);
			else list.push(doc);
		}
		for (const decision of enriched) {
			const docs = byPath.get(decision.key.path);
			if (docs === undefined || docs.length === 0) continue;
			this.tracker.recordEnrichmentByContent(
				decision.key,
				docs.map((doc) => ({
					documentType: doc.documentType,
					summaryId: doc.id,
					state: "complete" as const,
					sourceIds: doc.sourceIds ?? [],
					createdAt: doc.createdAt,
					enrichedAt: doc.enrichedAt ?? doc.createdAt,
					producer,
				})),
			);
			await yieldToEventLoop();
		}
	}

	/**
	 * Write a batch of enriched documents, under the branch model (§4.1).
	 *
	 * THE ONLY PLACE summaries reach LanceDB, so the journal and the
	 * registration are here rather than at each of the two call sites that used
	 * to call `addDocuments` directly.
	 *
	 * A summary id incorporates the summary's own text
	 * (`sha256(documentType::filePath::content)`), so re-enriching a file whose
	 * LLM output came back identical produces the SAME id — and `addDocuments`
	 * is a bare append. The tier-1 hit test is what turns that into a widen
	 * instead of a second row.
	 *
	 * NARROW_SUMMARIES is the caller's, and runs per file after this returns:
	 * this method does not know which files the caller considers finished, and
	 * narrowing a class whose producer did not run deletes every summary the
	 * branch has (§4.1.1's "never run early" guard).
	 */
	private async persistDocuments(
		documents: DocumentWithEmbedding[],
		membership: RowMembership,
	): Promise<void> {
		if (documents.length === 0) return;

		const ids = documents.map((doc) => doc.id);
		// A summary id incorporates the summary TEXT, so a registered id whose
		// content hash still matches really is the same row — the code-unit
		// collision `refreshCodeUnits` exists for cannot happen here.
		const registered = this.tracker.knownChunkRows(ids);
		const live = await this.vectorStore.existingIds([...registered.keys()]);
		const toInsert = documents.filter((doc) => !live.has(doc.id));
		const toWiden = documents.filter((doc) => live.has(doc.id));

		const insertedIds = toInsert.map((doc) => doc.id);
		// R5a (§4.1.4): the append is bracketed, so a crash before the
		// registration below leaves intents naming exactly the appended ids and
		// the next run's recovery deletes them.
		this.tracker.beginAddIntents(membership.branchId, insertedIds);
		await yieldToEventLoop();
		if (toInsert.length > 0) {
			await this.vectorStore.addDocuments(toInsert, membership);
		}
		// R5b: register, commit membership for inserted AND widened ids, record
		// the widen work, clear the intents. No `files` stamp — the chunk pass
		// wrote it, and a summary is not what makes a file indexed.
		this.tracker.commitAddBatch(membership.branchId, {
			registered: toInsert.map((doc) => ({
				chunkId: doc.id,
				pathKind: membership.pathKind,
				path: doc.filePath || "",
				contentHash: computeHash(doc.content),
				rowClass: "document" as const,
			})),
			memberIds: [...insertedIds, ...toWiden.map((doc) => doc.id)],
			widenIds: toWiden.map((doc) => doc.id),
			files: [],
			clearAddIntentIds: insertedIds,
		});
		await yieldToEventLoop();
	}

	/**
	 * NARROW_SUMMARIES (§4.1.1) for the files this pass enriched.
	 *
	 * Runs AFTER the producer of its own class and only over files the producer
	 * actually finished: a summary id incorporates the source content, so the
	 * previous revision's summary keeps pointing at this branch forever unless
	 * it is narrowed — a ghost summary that grows per edit and that the orphan
	 * sweep cannot collect, because its membership is not empty.
	 */
	private async narrowSummaries(
		membership: RowMembership,
		newIdsByFile: ReadonlyMap<string, Set<string>>,
	): Promise<void> {
		for (const [filePath, newIds] of newIdsByFile) {
			if (filePath === "") continue;
			const oldIds = this.tracker
				.chunkIdsForPath(
					membership.branchId,
					membership.pathKind,
					filePath,
					"document",
				)
				.map((row) => row.chunkId);
			await yieldToEventLoop();
			await narrowIds(
				this.tracker,
				this.vectorStore,
				membership.branchId,
				oldIds.filter((id) => !newIds.has(id)),
			);
			await yieldToEventLoop();
		}
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
	needsEnrichment(
		branchId: number,
		filePath: string,
		documentType: DocumentType,
	): boolean {
		return this.tracker.needsEnrichment(branchId, filePath, documentType);
	}

	/**
	 * Get files that need enrichment for a document type
	 */
	getFilesNeedingEnrichment(
		branchId: number,
		documentType: DocumentType,
	): string[] {
		return this.tracker.getFilesNeedingEnrichment(branchId, documentType);
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
							// Update the summary in the vector store BEFORE the
							// counters move. A refinement whose write did not land
							// is not a success: the store either restored the old
							// summary or lost the row outright (LanceDB has no
							// upsert, so the update is delete + add), and either
							// way the refined text is not in the index. The write
							// throws `VectorStoreUpdateError` on failure — it used
							// to return `false` here, indistinguishably from "no
							// such document", and this call site ignored both.
							if (refinementResult.rounds > 0) {
								// Re-embed the refined summary
								const embedResult = await this.embeddingsClient.embed([
									refinementResult.finalSummary,
								]);
								const newVector = embedResult.embeddings[0];

								const written = await this.vectorStore.updateDocumentContent(
									summary.id,
									refinementResult.finalSummary,
									newVector,
								);
								if (!written) {
									// The document was removed between the read
									// that found it and this write. Nothing was
									// destroyed; it just is not there to refine.
									throw new Error(
										`Summary ${summary.id} is no longer in the index`,
									);
								}
							}

							successCount++;
							roundsSum += refinementResult.rounds;
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
