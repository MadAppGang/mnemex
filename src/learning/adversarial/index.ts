/**
 * Adversarial Safety Module - Red Team / Blue Team testing for improvements.
 *
 * This module provides:
 * - RedTeam: Attack generated improvements to find vulnerabilities
 * - BlueTeam: Defend and validate improvements
 * - SafetyScorer: Compute final safety score for auto-deploy gating
 *
 * Workflow:
 * 1. RedTeam attacks the improvement with edge cases, injections, etc.
 * 2. BlueTeam applies mitigations and validates safety
 * 3. SafetyScorer combines scores to make deployment decision
 *
 * Usage:
 * ```typescript
 * import {
 *   createRedTeam,
 *   createBlueTeam,
 *   createSafetyScorer
 * } from "./learning/adversarial/index.js";
 *
 * const redTeam = createRedTeam({ intensity: 0.8 });
 * const blueTeam = createBlueTeam({ autoMitigate: true });
 * const scorer = createSafetyScorer();
 *
 * // Attack the improvement
 * const redReport = redTeam.attackImprovement(improvement);
 *
 * // Defend and validate
 * const blueReport = blueTeam.validateImprovement(improvement, redReport);
 *
 * // Get final score and decision
 * const result = scorer.score(improvement, redReport, blueReport, {
 *   patternConfidence: 0.85
 * });
 *
 * if (result.decision === 'auto_deploy') {
 *   // Safe to deploy automatically
 * } else if (result.decision === 'human_review') {
 *   // Queue for human approval
 * } else {
 *   // Reject improvement
 * }
 * ```
 */

// Red Team - Attack generated improvements
export {
	RedTeam,
	createRedTeam,
	DEFAULT_RED_CONFIG,
	type RedTeamConfig,
	type AttackType,
	type AttackResult,
	type Attack,
	type AttackPayload,
	type AttackOutcome,
	type RedTeamReport,
} from "./red-team.js";

// Blue Team - Defend and validate
export {
	BlueTeam,
	createBlueTeam,
	DEFAULT_BLUE_CONFIG,
	type BlueTeamConfig,
	type MitigationType,
	type Mitigation,
	type MitigationApplication,
	type DefenseReport,
	type ValidationRule,
	type ValidationResult,
} from "./blue-team.js";

// Safety Scorer - Final deployment decision
export {
	SafetyScorer,
	createSafetyScorer,
	DEFAULT_SCORER_CONFIG,
	type SafetyScorerConfig,
	type DeploymentDecision,
	type SafetyScoreResult,
	type SafetyFactor,
	type HistoricalData,
	type ScoringContext,
} from "./safety-scorer.js";
