/**
 * Evaluators Module
 *
 * Exports all evaluation components:
 * - Judge: LLM-as-Judge (pointwise + pairwise)
 * - Contrastive: Summary-to-code matching
 * - Retrieval: P@K and MRR metrics
 * - Downstream: Code completion, bug localization, function selection
 */

// Base evaluator
export {
	BaseEvaluator,
	isSameModelFamily,
	getModelFamily,
	selectJudges,
} from "./base.js";

// Judge evaluators
export {
	PointwiseJudgeEvaluator,
	createPointwiseJudgeEvaluator,
} from "./judge/pointwise.js";

export {
	PairwiseJudgeEvaluator,
	createPairwiseJudgeEvaluator,
	aggregateTournamentResults,
} from "./judge/pairwise.js";

export { createJudgePhaseExecutor } from "./judge/index.js";

// Contrastive evaluators
export {
	EmbeddingContrastiveEvaluator,
	LLMContrastiveEvaluator,
	createEmbeddingContrastiveEvaluator,
	createLLMContrastiveEvaluator,
	selectDistractors,
	createContrastivePhaseExecutor,
} from "./contrastive/index.js";

// Retrieval evaluator
export {
	RetrievalEvaluator,
	createRetrievalEvaluator,
	aggregateRetrievalResults,
	createRetrievalPhaseExecutor,
	type AggregatedRetrievalMetrics,
} from "./retrieval/index.js";

// Downstream evaluators
export {
	DownstreamEvaluator,
	createDownstreamEvaluator,
	generateCompletionTasks,
	generateBugLocalizationTasks,
	generateFunctionSelectionTasks,
	createDownstreamPhaseExecutor,
} from "./downstream/index.js";
