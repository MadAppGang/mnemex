/**
 * Deployment Module - A/B testing, metrics, and rollback.
 *
 * This module provides:
 * - ABTestManager: Controlled rollout with statistical significance testing
 * - MetricsTracker: Time-series metrics and trend analysis
 * - RollbackManager: Revert improvements on regression
 *
 * Usage:
 * ```typescript
 * import {
 *   createABTestManager,
 *   createMetricsTracker,
 *   createRollbackManager
 * } from "./learning/deployment/index.js";
 *
 * // Set up A/B testing
 * const abTest = createABTestManager({ trafficPercent: 10 });
 * const experiment = abTest.createExperiment(improvement);
 * abTest.startExperiment(experiment.experimentId);
 *
 * // Track metrics
 * const metrics = createMetricsTracker();
 * metrics.recordSession(corrections, errors, autonomous, duration);
 *
 * // Handle rollbacks
 * const rollback = createRollbackManager();
 * const candidate = rollback.evaluateForRollback(improvement, currentMetrics, anomalies);
 * if (candidate.recommendation === "rollback") {
 *   rollback.initiateRollback(improvement, candidate.reason, "Regression detected");
 * }
 * ```
 */

// A/B Testing
export {
	ABTestManager,
	createABTestManager,
	DEFAULT_AB_CONFIG,
	type ABTestConfig,
	type Experiment,
	type ExperimentMetrics,
	type ExperimentStatus,
	type StatisticalResult,
	type ExperimentDecision,
} from "./ab-testing.js";

// Metrics Tracker
export {
	MetricsTracker,
	createMetricsTracker,
	DEFAULT_METRICS_CONFIG,
	type MetricsTrackerConfig,
	type MetricDataPoint,
	type MetricSeries,
	type MetricsSnapshot,
	type ImprovementMetrics,
	type MetricAnomaly,
	type TrendAnalysis,
} from "./metrics-tracker.js";

// Rollback Manager
export {
	RollbackManager,
	createRollbackManager,
	DEFAULT_ROLLBACK_CONFIG,
	type RollbackManagerConfig,
	type RollbackEvent,
	type RollbackMetrics,
	type RollbackCandidate,
	type RollbackStatus,
	type RollbackReason,
} from "./rollback.js";
