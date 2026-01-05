/**
 * Types for User-Agent Interaction Monitoring & Continuous Learning System
 *
 * This module defines interfaces for:
 * - Session tracking and lifecycle
 * - Tool execution events
 * - Code changes and "Correction Gap" detection
 * - Implicit correction signals
 * - Pattern detection and improvements
 */

// ============================================================================
// Session Types
// ============================================================================

/** Session outcome classification */
export type SessionOutcome = "success" | "partial" | "failure" | "abandoned";

/** Tool error classification */
export type ToolErrorType = "timeout" | "permission" | "validation" | "logic" | "unknown";

/** Correction classification based on user behavior */
export type CorrectionType = "undo" | "enhance" | "independent";

/** Pattern types for learning */
export type PatternType = "error" | "workflow" | "misuse" | "opportunity";

/** Pattern severity levels */
export type PatternSeverity = "critical" | "medium" | "low";

/** Improvement types */
export type ImprovementType = "skill" | "subagent" | "prompt";

/** Improvement status in deployment pipeline */
export type ImprovementStatus =
	| "proposed"
	| "testing"
	| "approved"
	| "deployed"
	| "rolled_back";

/**
 * Agent session metadata.
 * Tracks a complete user-agent interaction session.
 */
export interface AgentSession {
	sessionId: string;
	timestamp: number;
	projectPath: string;
	duration?: number;
	toolCount: number;
	interventionCount: number;
	autonomousCount: number;
	outcome?: SessionOutcome;
}

/**
 * Tool execution event.
 * Captures each tool invocation with timing and outcome.
 */
export interface ToolEvent {
	id?: number;
	sessionId: string;
	toolUseId: string;
	toolName: string;
	toolInputHash?: string;
	success: boolean;
	errorType?: ToolErrorType;
	/** Error message if failed */
	error?: string;
	durationMs?: number;
	executionOrder: number;
	timestamp: number;
}

/**
 * Code change event.
 * Tracks file modifications by agent or user for "Correction Gap" analysis.
 */
export interface CodeChange {
	id?: number;
	sessionId: string;
	filePath: string;
	author: "agent" | "user";
	diffHash?: string;
	linesAdded: number;
	linesRemoved: number;
	timestamp: number;
	/** Links to agent's prior change if this is a user correction */
	agentChangeId?: number;
	/** Type of correction (if user modified agent's work) */
	correctionType?: CorrectionType;
}

/**
 * Correction signals for multi-signal detection.
 * Each signal is 0.0 to 1.0 representing confidence.
 */
export interface CorrectionSignals {
	/** Lexical indicators in user message ("no", "actually", "wrong") */
	lexical: number;
	/** Sudden change in tool strategy after failure */
	pivot: number;
	/** User edits same file region after agent */
	overwrite: number;
	/** User repeats similar prompt */
	reask: number;
}

/**
 * Detected user correction event.
 * Captures when user corrects agent behavior.
 */
export interface CorrectionEvent {
	id?: number;
	sessionId: string;
	/** Combined correction score (0.0 to 1.0) */
	correctionScore: number;
	/** Individual signal scores */
	signals: CorrectionSignals;
	/** What the user said or did */
	triggerEvent?: string;
	/** What agent did before correction */
	agentAction?: string;
	timestamp: number;
}

/**
 * Detected pattern from analysis.
 */
export interface DetectedPattern {
	patternId: string;
	patternType: PatternType;
	patternHash: string;
	patternData: PatternData;
	occurrenceCount: number;
	lastSeen: number;
	severity: PatternSeverity;
	/** NULL = global, otherwise project-specific */
	projectScope?: string;
}

/**
 * Pattern data structure.
 * Flexible structure to accommodate different pattern types.
 */
export interface PatternData {
	description: string;
	/** Tool sequence for workflow patterns */
	toolSequence?: string[];
	sequence?: string[];
	/** Error signature for error patterns */
	errorSignature?: string;
	/** Tools involved in the pattern */
	tools?: string[];
	/** Error types for error patterns */
	errorTypes?: string[];
	/** Support (0.0 to 1.0) */
	support?: number;
	/** Confidence score (0.0 to 1.0) */
	confidence?: number;
	/** Lift for association rules */
	lift?: number;
	/** Example session IDs */
	exampleSessions?: string[];
	/** Automation potential (0.0 to 1.0) for workflow patterns */
	automationPotential?: number;
	/** Average duration in ms for workflow patterns */
	avgDurationMs?: number;
	/** Success rate (0.0 to 1.0) */
	successRate?: number;
	/** Category for workflow patterns */
	category?: string;
	/** Occurrences count */
	occurrences?: number;
	/** Allow additional properties */
	[key: string]: unknown;
}

/**
 * Generated improvement proposal.
 */
export interface Improvement {
	improvementId: string;
	patternId: string;
	improvementType: ImprovementType;
	improvementData: ImprovementData;
	status: ImprovementStatus;
	/** Safety score for auto-deploy gate (0.0 to 1.0) */
	safetyScore?: number;
	impactScore?: number;
	createdAt: number;
	approvedAt?: number;
	deployedAt?: number;
}

/**
 * Improvement data based on type.
 */
export interface ImprovementData {
	name: string;
	description: string;
	/** For skills: implementation steps */
	implementation?: string;
	/** For subagents: system prompt */
	systemPrompt?: string;
	/** For prompts: original and revised text */
	originalPrompt?: string;
	revisedPrompt?: string;
	/** Evidence from patterns */
	evidence: {
		patternId: string;
		occurrences: number;
		confidence: number;
	};
}

// ============================================================================
// Statistics Types
// ============================================================================

/**
 * Session statistics summary.
 */
export interface SessionStatistics {
	totalSessions: number;
	totalToolEvents: number;
	totalCorrections: number;
	avgInterventionRate: number;
	avgSessionDuration: number;
	outcomeBreakdown: Record<SessionOutcome, number>;
	topToolsUsed: Array<{ toolName: string; count: number }>;
	recentSessions: AgentSession[];
}

/**
 * Pattern statistics summary.
 */
export interface PatternStatistics {
	totalPatterns: number;
	patternsByType: Record<PatternType, number>;
	patternsBySeverity: Record<PatternSeverity, number>;
	topPatterns: DetectedPattern[];
}

/**
 * Improvement statistics summary.
 */
export interface ImprovementStatistics {
	totalImprovements: number;
	improvementsByType: Record<ImprovementType, number>;
	improvementsByStatus: Record<ImprovementStatus, number>;
	avgSafetyScore: number;
	avgImpactScore: number;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for interaction monitoring.
 */
export interface InteractionConfig {
	/** Enable/disable interaction logging */
	enabled: boolean;
	/** Raw event retention in days */
	rawEventRetentionDays: number;
	/** Session summary retention in days */
	summaryRetentionDays: number;
	/** Hash tool inputs for privacy (store hash not raw) */
	hashToolInputs: boolean;
	/** Correction score weights */
	correctionWeights: CorrectionWeights;
	/** Minimum correction score to record */
	minCorrectionScore: number;
	/** Safety score threshold for auto-deploy */
	autoDeploySafetyThreshold: number;
}

/**
 * Weights for multi-signal correction detection.
 */
export interface CorrectionWeights {
	lexical: number;
	pivot: number;
	overwrite: number;
	reask: number;
}

/**
 * Default interaction configuration.
 */
export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
	enabled: true,
	rawEventRetentionDays: 7,
	summaryRetentionDays: 30,
	hashToolInputs: true,
	correctionWeights: {
		lexical: 0.3,
		pivot: 0.2,
		overwrite: 0.35,
		reask: 0.15,
	},
	minCorrectionScore: 0.5,
	autoDeploySafetyThreshold: 0.9,
};
