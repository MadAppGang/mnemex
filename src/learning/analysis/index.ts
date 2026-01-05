/**
 * Analysis Module - Pattern mining and error clustering.
 *
 * This module provides:
 * - PatternMiner: FP-Growth and PrefixSpan for frequent pattern discovery
 * - ErrorClusterer: Hierarchical clustering of similar errors
 * - WorkflowDetector: Identifies automatable tool sequences
 *
 * Usage:
 * ```typescript
 * import {
 *   createPatternMiner,
 *   createErrorClusterer,
 *   createWorkflowDetector
 * } from "./learning/analysis/index.js";
 *
 * // Mine patterns from tool events
 * const miner = createPatternMiner();
 * const patterns = miner.minePatterns(events, sessionIds);
 * console.log("Error patterns:", patterns.errorPatterns);
 * console.log("Workflow patterns:", patterns.workflowPatterns);
 *
 * // Cluster errors
 * const clusterer = createErrorClusterer();
 * const clusters = clusterer.cluster(events);
 * console.log("Top error clusters:", clusterer.getTopClusters(clusters));
 *
 * // Detect workflows
 * const detector = createWorkflowDetector();
 * const workflows = detector.detect(events);
 * console.log("Automatable workflows:", workflows.topAutomatable);
 * console.log("Skill suggestions:", detector.suggestSkills(workflows));
 * ```
 */

// Pattern Miner
export {
	PatternMiner,
	createPatternMiner,
	DEFAULT_MINER_CONFIG,
	type PatternMinerConfig,
	type FrequentItemset,
	type AssociationRule,
	type SequentialPattern,
	type MinedPatterns,
} from "./pattern-miner.js";

// Error Clusterer
export {
	ErrorClusterer,
	createErrorClusterer,
	DEFAULT_CLUSTER_CONFIG,
	type ErrorClusterConfig,
	type ErrorInstance,
	type ErrorCluster,
	type ClusteringResult,
} from "./error-clusterer.js";

// Workflow Detector
export {
	WorkflowDetector,
	createWorkflowDetector,
	DEFAULT_WORKFLOW_CONFIG,
	type WorkflowDetectorConfig,
	type Workflow,
	type WorkflowAnalysis,
} from "./workflow-detector.js";
