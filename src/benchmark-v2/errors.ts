/**
 * Benchmark V2 Error Hierarchy
 *
 * Structured error types for the benchmark system.
 * Each error includes context for debugging and potential recovery.
 */

import type { BenchmarkPhase, EvaluationType, ModelProvider } from "./types.js";

// ============================================================================
// Base Error Class
// ============================================================================

export class BenchmarkError extends Error {
	/** Error code for programmatic handling */
	readonly code: string;
	/** Phase where error occurred */
	readonly phase?: BenchmarkPhase;
	/** Additional context */
	readonly context?: Record<string, unknown>;
	/** Whether this error is recoverable (can retry) */
	readonly recoverable: boolean;

	constructor(
		message: string,
		code: string,
		options?: {
			phase?: BenchmarkPhase;
			context?: Record<string, unknown>;
			recoverable?: boolean;
			cause?: Error;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "BenchmarkError";
		this.code = code;
		this.phase = options?.phase;
		this.context = options?.context;
		this.recoverable = options?.recoverable ?? false;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			phase: this.phase,
			context: this.context,
			recoverable: this.recoverable,
			stack: this.stack,
		};
	}
}

// ============================================================================
// Configuration Errors
// ============================================================================

export class ConfigurationError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "CONFIG_ERROR", {
			context,
			recoverable: false,
			cause,
		});
		this.name = "ConfigurationError";
	}
}

export class InvalidModelConfigError extends ConfigurationError {
	readonly modelId: string;
	readonly provider: ModelProvider;

	constructor(
		modelId: string,
		provider: ModelProvider,
		reason: string,
		cause?: Error,
	) {
		super(
			`Invalid model configuration for ${modelId}: ${reason}`,
			{
				modelId,
				provider,
				reason,
			},
			cause,
		);
		this.name = "InvalidModelConfigError";
		this.modelId = modelId;
		this.provider = provider;
	}
}

export class MissingApiKeyError extends ConfigurationError {
	readonly provider: ModelProvider;

	constructor(provider: ModelProvider) {
		super(`Missing API key for provider: ${provider}`, { provider });
		this.name = "MissingApiKeyError";
		this.provider = provider;
	}
}

// ============================================================================
// Extraction Errors
// ============================================================================

export class ExtractionError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "EXTRACTION_ERROR", {
			phase: "extraction",
			context,
			recoverable: true,
			cause,
		});
		this.name = "ExtractionError";
	}
}

export class FileParseError extends ExtractionError {
	readonly filePath: string;
	readonly language: string;

	constructor(
		filePath: string,
		language: string,
		reason: string,
		cause?: Error,
	) {
		super(
			`Failed to parse ${filePath}: ${reason}`,
			{
				filePath,
				language,
				reason,
			},
			cause,
		);
		this.name = "FileParseError";
		this.filePath = filePath;
		this.language = language;
	}
}

export class UnsupportedLanguageError extends ExtractionError {
	readonly language: string;
	readonly filePath: string;

	constructor(language: string, filePath: string) {
		super(`Unsupported language: ${language}`, { language, filePath });
		this.name = "UnsupportedLanguageError";
		this.language = language;
		this.filePath = filePath;
	}
}

// ============================================================================
// Generation Errors
// ============================================================================

export class GenerationError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "GENERATION_ERROR", {
			phase: "generation",
			context,
			recoverable: true,
			cause,
		});
		this.name = "GenerationError";
	}
}

export class ModelApiError extends GenerationError {
	readonly modelId: string;
	readonly provider: ModelProvider;
	readonly statusCode?: number;

	constructor(
		modelId: string,
		provider: ModelProvider,
		reason: string,
		options?: {
			statusCode?: number;
			cause?: Error;
		},
	) {
		super(
			`API error from ${provider}/${modelId}: ${reason}`,
			{
				modelId,
				provider,
				statusCode: options?.statusCode,
				reason,
			},
			options?.cause,
		);
		this.name = "ModelApiError";
		this.modelId = modelId;
		this.provider = provider;
		this.statusCode = options?.statusCode;
	}
}

export class RateLimitError extends ModelApiError {
	readonly retryAfterMs?: number;

	constructor(modelId: string, provider: ModelProvider, retryAfterMs?: number) {
		super(modelId, provider, "Rate limit exceeded", { statusCode: 429 });
		this.name = "RateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class ModelTimeoutError extends GenerationError {
	readonly modelId: string;
	readonly timeoutMs: number;

	constructor(modelId: string, timeoutMs: number) {
		super(`Model ${modelId} timed out after ${timeoutMs}ms`, {
			modelId,
			timeoutMs,
		});
		this.name = "ModelTimeoutError";
		this.modelId = modelId;
		this.timeoutMs = timeoutMs;
	}
}

export class InvalidResponseError extends GenerationError {
	readonly modelId: string;
	readonly response: string;

	constructor(modelId: string, reason: string, response: string) {
		super(`Invalid response from ${modelId}: ${reason}`, {
			modelId,
			reason,
			response: response.slice(0, 500), // Truncate for logging
		});
		this.name = "InvalidResponseError";
		this.modelId = modelId;
		this.response = response;
	}
}

// ============================================================================
// Evaluation Errors
// ============================================================================

export class EvaluationError extends BenchmarkError {
	readonly evaluationType: EvaluationType;

	constructor(
		message: string,
		evaluationType: EvaluationType,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "EVALUATION_ERROR", {
			phase: `evaluation:${evaluationType}` as BenchmarkPhase,
			context: { ...context, evaluationType },
			recoverable: true,
			cause,
		});
		this.name = "EvaluationError";
		this.evaluationType = evaluationType;
	}
}

export class JudgeError extends EvaluationError {
	readonly judgeModel: string;

	constructor(
		judgeModel: string,
		reason: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(
			`Judge ${judgeModel} failed: ${reason}`,
			"judge",
			{
				...context,
				judgeModel,
				reason,
			},
			cause,
		);
		this.name = "JudgeError";
		this.judgeModel = judgeModel;
	}
}

export class SelfJudgingError extends JudgeError {
	readonly generatorModel: string;

	constructor(generatorModel: string, judgeModel: string) {
		super(judgeModel, `Cannot judge own summaries (model: ${generatorModel})`, {
			generatorModel,
		});
		this.name = "SelfJudgingError";
		this.generatorModel = generatorModel;
	}
}

export class ContrastiveError extends EvaluationError {
	constructor(
		reason: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(
			`Contrastive evaluation failed: ${reason}`,
			"contrastive",
			context,
			cause,
		);
		this.name = "ContrastiveError";
	}
}

export class InsufficientDistractorsError extends ContrastiveError {
	readonly targetId: string;
	readonly required: number;
	readonly available: number;

	constructor(targetId: string, required: number, available: number) {
		super(
			`Not enough distractors for ${targetId}: need ${required}, have ${available}`,
			{
				targetId,
				required,
				available,
			},
		);
		this.name = "InsufficientDistractorsError";
		this.targetId = targetId;
		this.required = required;
		this.available = available;
	}
}

export class RetrievalError extends EvaluationError {
	constructor(
		reason: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(
			`Retrieval evaluation failed: ${reason}`,
			"retrieval",
			context,
			cause,
		);
		this.name = "RetrievalError";
	}
}

export class DownstreamError extends EvaluationError {
	readonly taskType: string;
	readonly taskId: string;

	constructor(
		taskType: string,
		taskId: string,
		reason: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(
			`Downstream task ${taskType}/${taskId} failed: ${reason}`,
			"downstream",
			{
				...context,
				taskType,
				taskId,
			},
			cause,
		);
		this.name = "DownstreamError";
		this.taskType = taskType;
		this.taskId = taskId;
	}
}

// ============================================================================
// Storage Errors
// ============================================================================

export class StorageError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "STORAGE_ERROR", {
			context,
			recoverable: false,
			cause,
		});
		this.name = "StorageError";
	}
}

export class DatabaseError extends StorageError {
	readonly operation: string;

	constructor(operation: string, reason: string, cause?: Error) {
		super(
			`Database ${operation} failed: ${reason}`,
			{
				operation,
				reason,
			},
			cause,
		);
		this.name = "DatabaseError";
		this.operation = operation;
	}
}

export class RunNotFoundError extends StorageError {
	readonly runId: string;

	constructor(runId: string) {
		super(`Benchmark run not found: ${runId}`, { runId });
		this.name = "RunNotFoundError";
		this.runId = runId;
	}
}

export class CorruptedDataError extends StorageError {
	readonly dataType: string;
	readonly dataId: string;

	constructor(dataType: string, dataId: string, reason: string, cause?: Error) {
		super(
			`Corrupted ${dataType} data (${dataId}): ${reason}`,
			{
				dataType,
				dataId,
				reason,
			},
			cause,
		);
		this.name = "CorruptedDataError";
		this.dataType = dataType;
		this.dataId = dataId;
	}
}

// ============================================================================
// State Machine Errors
// ============================================================================

export class StateError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "STATE_ERROR", {
			context,
			recoverable: false,
			cause,
		});
		this.name = "StateError";
	}
}

export class InvalidPhaseTransitionError extends StateError {
	readonly currentPhase: BenchmarkPhase;
	readonly targetPhase: BenchmarkPhase;

	constructor(currentPhase: BenchmarkPhase, targetPhase: BenchmarkPhase) {
		super(`Invalid transition from ${currentPhase} to ${targetPhase}`, {
			currentPhase,
			targetPhase,
		});
		this.name = "InvalidPhaseTransitionError";
		this.currentPhase = currentPhase;
		this.targetPhase = targetPhase;
	}
}

export class IncompletePhaseError extends StateError {
	readonly phase: BenchmarkPhase;
	readonly reason: string;

	constructor(phase: BenchmarkPhase, reason: string) {
		super(`Cannot proceed from ${phase}: ${reason}`, { phase, reason });
		this.name = "IncompletePhaseError";
		this.phase = phase;
		this.reason = reason;
	}
}

// ============================================================================
// Aggregation Errors
// ============================================================================

export class AggregationError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "AGGREGATION_ERROR", {
			phase: "aggregation",
			context,
			recoverable: false,
			cause,
		});
		this.name = "AggregationError";
	}
}

export class InsufficientDataError extends AggregationError {
	readonly dataType: string;
	readonly required: number;
	readonly available: number;

	constructor(dataType: string, required: number, available: number) {
		super(
			`Insufficient ${dataType} for aggregation: need ${required}, have ${available}`,
			{
				dataType,
				required,
				available,
			},
		);
		this.name = "InsufficientDataError";
		this.dataType = dataType;
		this.required = required;
		this.available = available;
	}
}

// ============================================================================
// Reporting Errors
// ============================================================================

export class ReportingError extends BenchmarkError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: Error,
	) {
		super(message, "REPORTING_ERROR", {
			phase: "reporting",
			context,
			recoverable: true,
			cause,
		});
		this.name = "ReportingError";
	}
}

export class ReportGenerationError extends ReportingError {
	readonly format: string;

	constructor(format: string, reason: string, cause?: Error) {
		super(
			`Failed to generate ${format} report: ${reason}`,
			{
				format,
				reason,
			},
			cause,
		);
		this.name = "ReportGenerationError";
		this.format = format;
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Check if an error is recoverable */
export function isRecoverable(error: unknown): boolean {
	if (error instanceof BenchmarkError) {
		return error.recoverable;
	}
	return false;
}

/** Check if an error is a rate limit error */
export function isRateLimitError(error: unknown): error is RateLimitError {
	return error instanceof RateLimitError;
}

/** Wrap unknown errors in a BenchmarkError */
export function wrapError(
	error: unknown,
	phase?: BenchmarkPhase,
): BenchmarkError {
	if (error instanceof BenchmarkError) {
		return error;
	}

	const message = error instanceof Error ? error.message : String(error);

	return new BenchmarkError(message, "UNKNOWN_ERROR", {
		phase,
		recoverable: false,
		cause: error instanceof Error ? error : undefined,
	});
}

/** Extract a user-friendly message from an error */
export function getErrorMessage(error: unknown): string {
	if (error instanceof BenchmarkError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
