/**
 * Benchmark Evaluator
 *
 * Main orchestrator for the LLM benchmark.
 * Coordinates generators, judges, and scorers to produce benchmark results.
 */

import type { FileSummary, LLMProvider, SymbolSummary } from "../../types.js";
import type {
	AggregateScores,
	BenchmarkConfig,
	BenchmarkMetadata,
	BenchmarkPhase,
	BenchmarkResults,
	GenerationResult,
	GeneratorResults,
	IJudge,
	ISummaryGenerator,
	JudgmentResult,
	PerformanceMetrics,
	Rankings,
	TestCase,
	TestCaseResult,
} from "../types.js";
import { DEFAULT_WEIGHTS } from "../types.js";
import { createGenerator, parseGeneratorSpec } from "../generators/index.js";
import { createJudge } from "../judges/index.js";
import { LLMResolver } from "../../llm/resolver.js";
import { createCompositeScorer, CompositeScorer } from "../scorers/index.js";
import { createTestCaseSelector } from "./test-case-selector.js";

// ============================================================================
// Judge Types for Parallel Execution
// ============================================================================

/** Judge with provider info for cloud/local separation */
interface JudgeWithProvider {
	judge: IJudge;
	provider: LLMProvider;
	model: string;
}

// ============================================================================
// Benchmark Evaluator
// ============================================================================

export class BenchmarkEvaluator {
	private config: BenchmarkConfig;
	private generators: ISummaryGenerator[] = [];
	private judges: JudgeWithProvider[] = [];
	private testCases: TestCase[] = [];

	// Buffer for diagnostic messages during progress display
	private diagnosticBuffer: Array<{
		category: string;
		message: string;
		error?: Error;
		timestamp: string;
	}> = [];
	private progressDisplayActive = true; // Assume progress display is active during benchmark

	constructor(config: BenchmarkConfig) {
		this.config = config;
	}

	/**
	 * Log diagnostic message. Buffers messages while progress display is active
	 * to avoid corrupting the multi-line progress display.
	 */
	private logDiagnostic(
		category: string,
		message: string,
		error?: Error,
	): void {
		if (!this.config.verbose) return;

		const timestamp = new Date().toISOString().slice(11, 23);

		if (this.progressDisplayActive) {
			// Buffer the message instead of printing immediately
			this.diagnosticBuffer.push({ category, message, error, timestamp });
			return;
		}

		// Output directly if progress display is not active
		this.outputDiagnostic(category, message, timestamp, error);
	}

	/**
	 * Output a single diagnostic message to stderr.
	 */
	private outputDiagnostic(
		category: string,
		message: string,
		timestamp: string,
		error?: Error,
	): void {
		const prefix = `\x1b[2m[${timestamp}]\x1b[0m`;
		const categoryColors: Record<string, string> = {
			ERROR: "\x1b[31m", // Red
			WARN: "\x1b[33m", // Yellow
			INFO: "\x1b[36m", // Cyan
		};
		const categoryColor = categoryColors[category] || "\x1b[37m";
		const reset = "\x1b[0m";

		process.stderr.write(
			`${prefix} ${categoryColor}${category}${reset}: ${message}\n`,
		);
		if (error && error.stack) {
			// Only show first line of stack in verbose mode
			const stackLine = error.stack.split("\n")[1]?.trim() || "";
			if (stackLine) {
				process.stderr.write(`  \x1b[2m${stackLine}${reset}\n`);
			}
		}
	}

	/**
	 * Flush all buffered diagnostic messages.
	 * Call this after progress display is finished.
	 */
	flushDiagnostics(): void {
		this.progressDisplayActive = false;

		if (this.diagnosticBuffer.length === 0) return;

		process.stderr.write("\n\x1b[2m─── Diagnostic Log ───\x1b[0m\n");
		for (const entry of this.diagnosticBuffer) {
			this.outputDiagnostic(
				entry.category,
				entry.message,
				entry.timestamp,
				entry.error,
			);
		}
		process.stderr.write("\x1b[2m──────────────────────\x1b[0m\n\n");
		this.diagnosticBuffer = [];
	}

	/**
	 * Run the complete benchmark.
	 */
	async run(): Promise<BenchmarkResults> {
		const startTime = Date.now();

		if (this.config.verbose) {
			this.logDiagnostic(
				"INFO",
				"Verbose/diagnostic mode enabled - errors will be logged to stderr",
			);
		}

		// Phase 1: Prepare
		this.reportProgress("preparing", 0, 4, "Initializing generators...");
		await this.initializeGenerators();

		this.reportProgress("preparing", 1, 4, "Initializing judges...");
		await this.initializeJudges();

		this.reportProgress("preparing", 2, 4, "Selecting test cases...");
		await this.selectTestCases();

		this.reportProgress("preparing", 3, 4, "Ready to benchmark");

		// Phase 2: Generate summaries with each model
		// Strategy: Run cloud models in parallel, local models sequentially (GPU constraint)
		// Both sessions run in parallel with each other
		const allGenerations = new Map<
			string,
			Map<string, GenerationResult<FileSummary | SymbolSummary>>
		>();

		// Separate cloud and local generators
		const cloudGenerators = this.generators.filter(
			(g) => g.getInfo().provider !== "local",
		);
		const localGenerators = this.generators.filter(
			(g) => g.getInfo().provider === "local",
		);

		let completedCount = 0;
		const totalCount = this.generators.length;

		// Track errors per generator
		const generatorErrors = new Map<string, string[]>();

		// Run cloud models in parallel, local models sequentially
		// Both sessions run concurrently
		const runCloudModels = async () => {
			const results = await Promise.all(
				cloudGenerators.map(async (generator) => {
					const generatorId = generator.getInfo().model;
					const displayName = generator.getInfo().displayName;

					// Progress callback for per-test-case updates
					const onProgress = (completed: number, total: number) => {
						this.reportProgress(
							"generating",
							completed,
							total,
							`Running ${displayName}: ${completed}/${total}`,
						);
					};

					const { results: generations, errors } = await this.runGenerator(
						generator,
						onProgress,
					);
					completedCount++;

					// Store errors
					if (errors.length > 0) {
						generatorErrors.set(generatorId, errors);
					}

					// Determine success/failure based on results
					const successCount = generations.size;
					const failureCount = this.testCases.length - successCount;

					if (successCount === 0) {
						// All test cases failed
						this.reportProgress(
							"generating",
							this.testCases.length,
							this.testCases.length,
							`Failed ${displayName} (all ${failureCount} tests failed)`,
						);
					} else if (failureCount > 0) {
						// Some failures
						this.reportProgress(
							"generating",
							this.testCases.length,
							this.testCases.length,
							`Completed ${displayName} (${failureCount} failures)`,
						);
					} else {
						// All succeeded
						this.reportProgress(
							"generating",
							this.testCases.length,
							this.testCases.length,
							`Completed ${displayName}`,
						);
					}
					return { generatorId, generations, failureCount };
				}),
			);
			return results;
		};

		const runLocalModels = async () => {
			const results: Array<{
				generatorId: string;
				generations: Map<string, GenerationResult<FileSummary | SymbolSummary>>;
				failureCount: number;
			}> = [];
			for (const generator of localGenerators) {
				const generatorId = generator.getInfo().model;
				const displayName = generator.getInfo().displayName;

				// Progress callback for per-test-case updates
				const onProgress = (completed: number, total: number) => {
					this.reportProgress(
						"generating",
						completed,
						total,
						`Running ${displayName} (local): ${completed}/${total}`,
					);
				};

				const { results: generations, errors } = await this.runGenerator(
					generator,
					onProgress,
				);
				completedCount++;

				// Store errors
				if (errors.length > 0) {
					generatorErrors.set(generatorId, errors);
				}

				// Determine success/failure based on results
				const successCount = generations.size;
				const failureCount = this.testCases.length - successCount;

				if (successCount === 0) {
					// All test cases failed
					this.reportProgress(
						"generating",
						this.testCases.length,
						this.testCases.length,
						`Failed ${displayName} (all ${failureCount} tests failed)`,
					);
				} else if (failureCount > 0) {
					// Some failures
					this.reportProgress(
						"generating",
						this.testCases.length,
						this.testCases.length,
						`Completed ${displayName} (${failureCount} failures)`,
					);
				} else {
					// All succeeded
					this.reportProgress(
						"generating",
						this.testCases.length,
						this.testCases.length,
						`Completed ${displayName}`,
					);
				}
				results.push({ generatorId, generations, failureCount });
			}
			return results;
		};

		// Run both sessions in parallel
		const [cloudResults, localResults] = await Promise.all([
			runCloudModels(),
			runLocalModels(),
		]);

		// Merge results
		for (const { generatorId, generations, failureCount } of [
			...cloudResults,
			...localResults,
		]) {
			allGenerations.set(generatorId, generations);
			// Note: failure tracking is now handled during generation
		}

		// Phase 3: Judge all generations
		// Strategy: Run cloud judges in parallel, local judges sequentially
		// Each judge processes ALL generations independently
		const allJudgments = new Map<string, Map<string, JudgmentResult>>();
		const perJudgeBreakdowns = new Map<
			string,
			Array<{
				judge: string;
				qualityScore: number;
				usefulness: number;
				conciseness: number;
			}>
		>();

		if (this.judges.length > 0) {
			// Collect all (generatorId, testCaseId, generation) tuples
			const generationTuples: Array<{
				generatorId: string;
				testCaseId: string;
				generation: GenerationResult<FileSummary | SymbolSummary>;
				testCase: TestCase;
			}> = [];

			for (const [generatorId, generations] of allGenerations) {
				for (const [testCaseId, generation] of generations) {
					const testCase = this.testCases.find((tc) => tc.id === testCaseId)!;
					generationTuples.push({
						generatorId,
						testCaseId,
						generation,
						testCase,
					});
				}
			}

			const totalGenerations = generationTuples.length;

			// Separate cloud and local judges
			const cloudJudges = this.judges.filter((j) => j.provider !== "local");
			const localJudges = this.judges.filter((j) => j.provider === "local");

			// Per-judge results: judgeModel -> Map<generatorId, Map<testCaseId, JudgmentResult>>
			const perJudgeResults = new Map<
				string,
				Map<string, Map<string, JudgmentResult>>
			>();

			// Run a single judge through all generations
			const runJudge = async (
				judgeWithProvider: JudgeWithProvider,
			): Promise<void> => {
				const { judge, model } = judgeWithProvider;
				const judgeResults = new Map<string, Map<string, JudgmentResult>>();
				let completed = 0;

				for (const {
					generatorId,
					testCaseId,
					generation,
					testCase,
				} of generationTuples) {
					// Report progress for this judge
					this.reportProgress(
						"judging",
						completed,
						totalGenerations,
						`Judge ${model}: ${completed}/${totalGenerations}`,
					);

					try {
						const judgment = await judge.judge(generation.result, {
							filePath: testCase.filePath,
							fileContent: testCase.fileContent,
							language: testCase.language,
							codeChunk: testCase.codeChunk,
						});

						// Store result
						if (!judgeResults.has(generatorId)) {
							judgeResults.set(generatorId, new Map());
						}
						judgeResults.get(generatorId)!.set(testCaseId, judgment);
					} catch (error) {
						const err =
							error instanceof Error ? error : new Error(String(error));
						this.logDiagnostic(
							"ERROR",
							`Judge ${model} failed for ${testCaseId}: ${err.message}`,
							err,
						);

						// Store default judgment on error
						if (!judgeResults.has(generatorId)) {
							judgeResults.set(generatorId, new Map());
						}
						judgeResults.get(generatorId)!.set(testCaseId, {
							usefulness: 50,
							conciseness: 50,
							clarity: 50,
							qualityScore: 50,
							feedback: `Judgment failed: ${err.message}`,
							judgedBy: model,
							durationMs: 0,
						});
					}

					completed++;
				}

				// Final progress for this judge
				this.reportProgress(
					"judging",
					totalGenerations,
					totalGenerations,
					`Judge ${model}: ${totalGenerations}/${totalGenerations}`,
				);

				perJudgeResults.set(model, judgeResults);
			};

			// Run cloud judges in parallel, local judges sequentially
			// Both sessions run concurrently with each other
			const runCloudJudges = async () => {
				if (cloudJudges.length === 0) return;
				await Promise.all(cloudJudges.map(runJudge));
			};

			const runLocalJudges = async () => {
				for (const judgeWithProvider of localJudges) {
					await runJudge(judgeWithProvider);
				}
			};

			// Run both sessions in parallel
			await Promise.all([runCloudJudges(), runLocalJudges()]);

			// Aggregate results from all judges using median consensus
			for (const [generatorId, generations] of allGenerations) {
				const aggregatedJudgments = new Map<string, JudgmentResult>();

				for (const [testCaseId] of generations) {
					// Collect judgments from all judges for this generation
					const judgeResults: JudgmentResult[] = [];
					for (const [, judgeResultsMap] of perJudgeResults) {
						const genJudgments = judgeResultsMap.get(generatorId);
						if (genJudgments?.has(testCaseId)) {
							judgeResults.push(genJudgments.get(testCaseId)!);
						}
					}

					// Aggregate using median
					if (judgeResults.length > 0) {
						aggregatedJudgments.set(
							testCaseId,
							this.aggregateJudgments(judgeResults),
						);
					}
				}

				allJudgments.set(generatorId, aggregatedJudgments);
			}

			// Compute per-judge score breakdown for each generator (when multiple judges)
			if (this.judges.length > 1) {
				for (const [generatorId] of allGenerations) {
					const breakdown: Array<{
						judge: string;
						qualityScore: number;
						usefulness: number;
						conciseness: number;
					}> = [];

					for (const [judgeModel, judgeResultsMap] of perJudgeResults) {
						const genJudgments = judgeResultsMap.get(generatorId);
						if (genJudgments && genJudgments.size > 0) {
							// Calculate average scores from this judge for this generator
							const judgments = Array.from(genJudgments.values()).filter(
								(j) => !j.feedback?.startsWith("Judgment failed:"),
							);

							if (judgments.length > 0) {
								const avgUsefulness = Math.round(
									judgments.reduce((sum, j) => sum + j.usefulness, 0) /
										judgments.length,
								);
								const avgConciseness = Math.round(
									judgments.reduce((sum, j) => sum + j.conciseness, 0) /
										judgments.length,
								);
								const avgQuality = Math.round(
									judgments.reduce((sum, j) => sum + j.qualityScore, 0) /
										judgments.length,
								);

								breakdown.push({
									judge: judgeModel,
									qualityScore: avgQuality,
									usefulness: avgUsefulness,
									conciseness: avgConciseness,
								});
							}
						}
					}

					if (breakdown.length > 0) {
						perJudgeBreakdowns.set(generatorId, breakdown);
					}
				}
			}
		}

		// Phase 4: Score all results
		this.reportProgress(
			"scoring",
			0,
			this.generators.length,
			"Calculating scores...",
		);

		const generatorResults: GeneratorResults[] = [];

		// Collect all durations and costs for normalization
		const allDurations: number[] = [];
		const allCosts: number[] = [];

		for (const generations of allGenerations.values()) {
			for (const gen of generations.values()) {
				allDurations.push(gen.durationMs);
				allCosts.push(gen.usage.cost);
			}
		}

		// Create composite scorer with normalization data
		const weights = this.config.weights || DEFAULT_WEIGHTS;
		const compositeScorer = createCompositeScorer(
			allDurations,
			allCosts,
			weights,
		);

		for (let i = 0; i < this.generators.length; i++) {
			const generator = this.generators[i];
			const generatorId = generator.getInfo().model;

			this.reportProgress(
				"scoring",
				i,
				this.generators.length,
				`Scoring ${generator.getInfo().displayName}...`,
			);

			const generations = allGenerations.get(generatorId)!;
			const judgments = allJudgments.get(generatorId);
			const judgeBreakdown = perJudgeBreakdowns.get(generatorId);
			const errors = generatorErrors.get(generatorId);

			const result = await this.scoreGenerator(
				generator,
				generations,
				judgments,
				compositeScorer,
				judgeBreakdown,
				errors,
			);

			generatorResults.push(result);
		}

		// Phase 5: Compile results
		this.reportProgress("reporting", 0, 1, "Compiling results...");

		const rankings = this.calculateRankings(generatorResults);
		const metadata = this.createMetadata(startTime);

		return {
			metadata,
			generators: generatorResults,
			rankings,
		};
	}

	/**
	 * Initialize generators from config.
	 */
	private async initializeGenerators(): Promise<void> {
		this.generators = [];

		for (const genInfo of this.config.generators) {
			const generator = await createGenerator(
				genInfo.provider,
				genInfo.model,
				genInfo.displayName,
				genInfo.endpoint,
			);
			this.generators.push(generator);
		}
	}

	/**
	 * Initialize judges from config.
	 * Creates individual judges with provider tracking for parallel/sequential execution.
	 */
	private async initializeJudges(): Promise<void> {
		if (this.config.judges.length === 0) {
			this.logDiagnostic(
				"WARN",
				"No judges configured - usefulness/conciseness will default to 50%",
			);
			this.judges = [];
			return;
		}

		this.judges = [];

		for (const judgeSpec of this.config.judges) {
			try {
				const provider = this.detectJudgeProvider(judgeSpec);
				const judge = await createJudge(judgeSpec, provider);
				const model = judge.getInfo().model || judgeSpec;

				this.judges.push({ judge, provider, model });
				this.logDiagnostic("INFO", `Initialized judge: ${model} (${provider})`);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				this.logDiagnostic(
					"ERROR",
					`Failed to initialize judge ${judgeSpec}: ${err.message}`,
					err,
				);
			}
		}

		if (this.judges.length === 0) {
			this.logDiagnostic("WARN", "No judges could be initialized");
		} else {
			const cloudCount = this.judges.filter(
				(j) => j.provider !== "local",
			).length;
			const localCount = this.judges.length - cloudCount;
			this.logDiagnostic(
				"INFO",
				`Judges ready: ${cloudCount} cloud (parallel), ${localCount} local (sequential)`,
			);
		}
	}

	/**
	 * Detect provider from judge spec.
	 * Uses LLMResolver for consistent provider detection.
	 */
	private detectJudgeProvider(spec: string): LLMProvider {
		return LLMResolver.parseSpec(spec).provider;
	}

	/**
	 * Select test cases from the project.
	 */
	private async selectTestCases(): Promise<void> {
		const selector = createTestCaseSelector(this.config.projectPath);
		this.testCases = await selector.selectTestCases({
			maxTestCases: this.config.testCaseCount,
			types: this.config.testCaseTypes,
			diverseSizes: true,
		});

		if (this.testCases.length === 0) {
			throw new Error(
				"No test cases selected. Check that the project is indexed.",
			);
		}
	}

	/** Result from running a generator, including errors */
	private runGeneratorResult: {
		results: Map<string, GenerationResult<FileSummary | SymbolSummary>>;
		errors: string[];
	} = { results: new Map(), errors: [] };

	/**
	 * Run a generator on all test cases.
	 * Returns both successful results and error messages.
	 * @param onTestCaseProgress - Optional callback for per-test-case progress updates
	 */
	private async runGenerator(
		generator: ISummaryGenerator,
		onTestCaseProgress?: (completed: number, total: number) => void,
	): Promise<{
		results: Map<string, GenerationResult<FileSummary | SymbolSummary>>;
		errors: string[];
	}> {
		const results = new Map<
			string,
			GenerationResult<FileSummary | SymbolSummary>
		>();
		const errors: string[] = [];
		generator.resetUsage();

		const totalTestCases = this.testCases.length;
		let completedTestCases = 0;

		// Report initial progress
		onTestCaseProgress?.(0, totalTestCases);

		// Check if this is a batch generator
		const isBatch =
			"isBatch" in generator &&
			(generator as { isBatch?: boolean }).isBatch === true;

		if (isBatch) {
			// Batch generator: queue all requests first, then flush
			const batchGen = generator as unknown as ISummaryGenerator & {
				flushBatch: () => Promise<void>;
			};

			// Queue all requests (these return promises that will resolve after flush)
			const pendingResults = new Map<
				string,
				Promise<GenerationResult<FileSummary | SymbolSummary>>
			>();

			for (const testCase of this.testCases) {
				if (testCase.type === "file_summary") {
					pendingResults.set(
						testCase.id,
						batchGen.generateFileSummary(
							testCase.filePath,
							testCase.fileContent,
							testCase.language,
							testCase.codeChunks || [],
						),
					);
				} else {
					pendingResults.set(
						testCase.id,
						batchGen.generateSymbolSummary(
							testCase.codeChunk!,
							testCase.fileContent,
							testCase.language,
						),
					);
				}
			}

			// Flush the batch (submits to API and waits for all results)
			await batchGen.flushBatch();

			// Collect results
			for (const [testCaseId, promise] of pendingResults) {
				try {
					const result = await promise;
					results.set(testCaseId, result);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					const errorMsg = err.message;
					errors.push(errorMsg);
					this.logDiagnostic(
						"ERROR",
						`Batch generator failed for test case ${testCaseId}: ${errorMsg}`,
						err,
					);
				}
				completedTestCases++;
				onTestCaseProgress?.(completedTestCases, totalTestCases);
			}
		} else {
			// Standard generator: process requests sequentially
			for (const testCase of this.testCases) {
				try {
					let result: GenerationResult<FileSummary | SymbolSummary>;

					if (testCase.type === "file_summary") {
						result = await generator.generateFileSummary(
							testCase.filePath,
							testCase.fileContent,
							testCase.language,
							testCase.codeChunks || [],
						);
					} else {
						result = await generator.generateSymbolSummary(
							testCase.codeChunk!,
							testCase.fileContent,
							testCase.language,
						);
					}

					results.set(testCase.id, result);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					const errorMsg = err.message;
					errors.push(errorMsg);
					this.logDiagnostic(
						"ERROR",
						`Generator failed for ${testCase.filePath}: ${errorMsg}`,
						err,
					);
				}
				completedTestCases++;
				onTestCaseProgress?.(completedTestCases, totalTestCases);
			}
		}

		return { results, errors };
	}

	/**
	 * Aggregate multiple judgment results using median consensus.
	 */
	private aggregateJudgments(judgments: JudgmentResult[]): JudgmentResult {
		if (judgments.length === 0) {
			return {
				usefulness: 50,
				conciseness: 50,
				clarity: 50,
				qualityScore: 50,
				judgedBy: "no judge",
				durationMs: 0,
			};
		}

		if (judgments.length === 1) {
			return judgments[0];
		}

		// Filter out failed judgments
		const validJudgments = judgments.filter(
			(j) => !j.feedback?.startsWith("Judgment failed:"),
		);

		// If all failed, return first result
		if (validJudgments.length === 0) {
			return judgments[0];
		}

		// Aggregate using median
		const median = (values: number[]): number => {
			if (values.length === 0) return 0;
			const sorted = [...values].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 0
				? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
				: sorted[mid];
		};

		const usefulness = median(validJudgments.map((j) => j.usefulness));
		const conciseness = median(validJudgments.map((j) => j.conciseness));
		const clarity = median(validJudgments.map((j) => j.clarity));
		const qualityScore = Math.round(
			usefulness * 0.5 + conciseness * 0.25 + clarity * 0.25,
		);

		// Combine durations and judge names
		const totalDuration = validJudgments.reduce(
			(sum, j) => sum + j.durationMs,
			0,
		);
		const judgeNames = validJudgments.map((j) => j.judgedBy).join(", ");

		// Combine feedback
		const feedbackParts = validJudgments
			.map((j) => j.feedback)
			.filter((f): f is string => !!f);
		const feedback =
			feedbackParts.length > 0 ? feedbackParts.join(" | ") : undefined;

		return {
			usefulness,
			conciseness,
			clarity,
			qualityScore,
			feedback,
			judgedBy: `Consensus (${judgeNames})`,
			durationMs: totalDuration,
		};
	}

	/**
	 * Score a generator's results.
	 */
	private async scoreGenerator(
		generator: ISummaryGenerator,
		generations: Map<string, GenerationResult<FileSummary | SymbolSummary>>,
		judgments: Map<string, JudgmentResult> | undefined,
		compositeScorer: CompositeScorer,
		judgeBreakdown?: Array<{
			judge: string;
			qualityScore: number;
			usefulness: number;
			conciseness: number;
		}>,
		errors?: string[],
	): Promise<GeneratorResults> {
		const testCaseResults: TestCaseResult[] = [];
		let totalDuration = 0;
		let totalCost = 0;
		let totalTokens = 0;
		let failures = 0;

		for (const testCase of this.testCases) {
			const generation = generations.get(testCase.id);
			const judgment = judgments?.get(testCase.id);

			if (!generation) {
				failures++;
				continue;
			}

			// Score this test case
			const { overall, components } = await compositeScorer.scoreDetailed(
				testCase,
				generation,
				judgment,
			);

			testCaseResults.push({
				testCase,
				generation,
				judgment,
				scores: components,
				overallScore: overall,
			});

			totalDuration += generation.durationMs;
			totalCost += generation.usage.cost;
			totalTokens +=
				generation.usage.inputTokens + generation.usage.outputTokens;
		}

		// Calculate aggregate scores
		const scores = this.calculateAggregateScores(testCaseResults);

		// Add per-judge breakdown if available
		if (judgeBreakdown && judgeBreakdown.length > 0) {
			scores.judgeBreakdown = judgeBreakdown.map((jb) => ({
				judge: jb.judge,
				qualityScore: jb.qualityScore,
				usefulness: jb.usefulness,
				conciseness: jb.conciseness,
			}));
		}

		// Calculate metrics with errors
		const metrics: PerformanceMetrics = {
			avgDurationMs:
				testCaseResults.length > 0 ? totalDuration / testCaseResults.length : 0,
			totalCost,
			totalTokens,
			successRate: testCaseResults.length / this.testCases.length,
			failures,
			errors: errors && errors.length > 0 ? errors : undefined,
		};

		return {
			info: generator.getInfo(),
			scores,
			metrics,
			testCaseResults,
		};
	}

	/**
	 * Calculate aggregate scores from test case results.
	 */
	private calculateAggregateScores(results: TestCaseResult[]): AggregateScores {
		if (results.length === 0) {
			return {
				overall: 0,
				correctness: 0,
				completeness: 0,
				usefulness: 0,
				conciseness: 0,
				speed: 0,
				cost: 0,
			};
		}

		const avg = (values: number[]) =>
			values.length > 0
				? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
				: 0;

		const getScoresByCriterion = (criterion: string): number[] =>
			results
				.flatMap((r) => r.scores)
				.filter((s) => s.criterion === criterion)
				.map((s) => s.score);

		return {
			overall: avg(results.map((r) => r.overallScore)),
			correctness: avg(getScoresByCriterion("correctness")),
			completeness: avg(getScoresByCriterion("completeness")),
			usefulness: avg(getScoresByCriterion("usefulness")),
			conciseness: avg(getScoresByCriterion("conciseness")),
			speed: avg(getScoresByCriterion("speed")),
			cost: avg(getScoresByCriterion("cost")),
		};
	}

	/**
	 * Calculate rankings from generator results.
	 */
	private calculateRankings(results: GeneratorResults[]): Rankings {
		// Type for numeric score keys only
		type NumericScoreKey =
			| "overall"
			| "correctness"
			| "completeness"
			| "usefulness"
			| "conciseness"
			| "speed"
			| "cost";

		const sortBy = (key: NumericScoreKey) =>
			[...results]
				.sort((a, b) => b.scores[key] - a.scores[key])
				.map((r) => r.info.model);

		return {
			byOverallScore: sortBy("overall"),
			byCorrectness: sortBy("correctness"),
			bySpeed: sortBy("speed"),
			byCost: sortBy("cost"),
		};
	}

	/**
	 * Create benchmark metadata.
	 */
	private createMetadata(startTime: number): BenchmarkMetadata {
		const typeCounts: Record<string, number> = {
			file_summary: 0,
			symbol_summary: 0,
		};

		for (const tc of this.testCases) {
			typeCounts[tc.type]++;
		}

		return {
			projectPath: this.config.projectPath,
			timestamp: new Date().toISOString(),
			totalTestCases: this.testCases.length,
			testCaseTypes: typeCounts as Record<
				"file_summary" | "symbol_summary",
				number
			>,
			judges: this.config.judges,
			weights: this.config.weights || DEFAULT_WEIGHTS,
		};
	}

	/**
	 * Report progress via callback.
	 */
	private reportProgress(
		phase: BenchmarkPhase,
		completed: number,
		total: number,
		details?: string,
	): void {
		this.config.onProgress?.(phase, completed, total, details);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Benchmark run result including results and utility functions.
 */
export interface BenchmarkRunResult {
	results: BenchmarkResults;
	/** Call this after stopping the progress display to flush buffered diagnostic messages */
	flushDiagnostics: () => void;
}

/**
 * Create and run a benchmark.
 * Returns results and a flushDiagnostics function to call after progress display is stopped.
 */
export async function runBenchmark(
	config: BenchmarkConfig,
): Promise<BenchmarkRunResult> {
	const evaluator = new BenchmarkEvaluator(config);
	const results = await evaluator.run();
	return {
		results,
		flushDiagnostics: () => evaluator.flushDiagnostics(),
	};
}
