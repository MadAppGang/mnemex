/**
 * SafetyValidator - Validates generated improvements before deployment.
 *
 * This is the critical gating component that ensures auto-generated
 * skills, subagents, and prompt optimizations are safe before deployment.
 *
 * Validation checks:
 * - No dangerous commands or patterns
 * - No secret/credential exposure
 * - No destructive operations without confirmation
 * - Bounded resource usage
 * - Reversibility guarantees
 */

import type { Improvement, ImprovementData } from "../interaction/types.js";
import type { GeneratedSkill } from "./skill-generator.js";
import type { GeneratedSubagent } from "./subagent-composer.js";
import type { PromptOptimization } from "./prompt-optimizer.js";

// ============================================================================
// Types
// ============================================================================

export interface SafetyValidatorConfig {
	/** Minimum safety score for auto-deploy */
	autoDeployThreshold: number;
	/** Minimum safety score for human review */
	humanReviewThreshold: number;
	/** Maximum allowed restricted tools */
	maxRestrictedTools: number;
	/** Patterns that always require human review */
	alwaysReviewPatterns: RegExp[];
	/** Dangerous command patterns */
	dangerousPatterns: RegExp[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyValidatorConfig = {
	autoDeployThreshold: 0.9,
	humanReviewThreshold: 0.7,
	maxRestrictedTools: 3,
	alwaysReviewPatterns: [
		/delete|remove|drop/i,
		/sudo|root|admin/i,
		/password|secret|key|token|credential/i,
		/--force|--hard|-f\s/i,
		/rm\s+-rf/i,
	],
	dangerousPatterns: [
		/rm\s+-rf\s+[\/~]/i, // Recursive delete from root or home
		/>\s*\/dev\/sd[a-z]/i, // Write to disk device
		/mkfs\./i, // Format filesystem
		/dd\s+if=/i, // Disk dump
		/chmod\s+777/i, // World writable
		/:(){:|:&};:/i, // Fork bomb
		/curl.*\|\s*sh/i, // Pipe to shell
		/eval\s*\(/i, // Eval in code
		/exec\s*\(/i, // Exec in code (when not in safe context)
		/process\.env\./i, // Direct env access
		/ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET/i, // Known secret patterns
	],
};

export interface ValidationResult {
	/** Whether the improvement passed validation */
	passed: boolean;
	/** Computed safety score */
	safetyScore: number;
	/** Deployment recommendation */
	recommendation: "auto_deploy" | "human_review" | "reject";
	/** List of issues found */
	issues: ValidationIssue[];
	/** Suggestions for improving safety */
	suggestions: string[];
	/** Timestamp of validation */
	validatedAt: number;
}

export interface ValidationIssue {
	/** Issue severity */
	severity: "critical" | "high" | "medium" | "low";
	/** Issue category */
	category:
		| "dangerous_command"
		| "credential_exposure"
		| "destructive_operation"
		| "unbounded_resource"
		| "irreversible"
		| "missing_constraint";
	/** Issue description */
	description: string;
	/** Location in the improvement */
	location?: string;
	/** Score penalty (0-1) */
	penalty: number;
}

export interface BatchValidationResult {
	total: number;
	passed: number;
	autoDeployable: number;
	needsReview: number;
	rejected: number;
	results: Map<string, ValidationResult>;
}

// ============================================================================
// SafetyValidator Class
// ============================================================================

export class SafetyValidator {
	private config: SafetyValidatorConfig;

	constructor(config: Partial<SafetyValidatorConfig> = {}) {
		this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
	}

	/**
	 * Validate a single improvement.
	 */
	validate(improvement: Improvement): ValidationResult {
		const issues: ValidationIssue[] = [];
		let baseScore = improvement.safetyScore ?? 0.8;

		// Run validation checks based on improvement type
		switch (improvement.improvementType) {
			case "skill":
				this.validateSkillImprovement(improvement.improvementData, issues);
				break;
			case "subagent":
				this.validateSubagentImprovement(improvement.improvementData, issues);
				break;
			case "prompt":
				this.validatePromptImprovement(improvement.improvementData, issues);
				break;
		}

		// Calculate final score
		const totalPenalty = issues.reduce((sum, i) => sum + i.penalty, 0);
		const safetyScore = Math.max(0, baseScore - totalPenalty);

		// Determine recommendation
		const recommendation = this.determineRecommendation(safetyScore, issues);

		// Generate suggestions
		const suggestions = this.generateSuggestions(issues);

		return {
			passed: recommendation !== "reject",
			safetyScore,
			recommendation,
			issues,
			suggestions,
			validatedAt: Date.now(),
		};
	}

	/**
	 * Validate a generated skill directly.
	 */
	validateSkill(skill: GeneratedSkill): ValidationResult {
		const issues: ValidationIssue[] = [];
		let baseScore = skill.confidence * 0.8 + 0.2;

		// Check implementation steps
		for (const step of skill.implementation) {
			this.checkDangerousPatterns(step, "implementation", issues);
		}

		// Check trigger condition
		this.checkDangerousPatterns(skill.triggerCondition, "trigger", issues);

		// Check constraints exist
		if (skill.constraints.length === 0) {
			issues.push({
				severity: "medium",
				category: "missing_constraint",
				description: "Skill has no safety constraints",
				penalty: 0.1,
			});
		}

		// Check for user approval constraint
		const hasApprovalConstraint = skill.constraints.some(
			(c) =>
				c.toLowerCase().includes("approve") ||
				c.toLowerCase().includes("confirm")
		);
		if (!hasApprovalConstraint) {
			issues.push({
				severity: "low",
				category: "missing_constraint",
				description: "No user approval constraint",
				penalty: 0.05,
			});
		}

		const totalPenalty = issues.reduce((sum, i) => sum + i.penalty, 0);
		const safetyScore = Math.max(0, baseScore - totalPenalty);
		const recommendation = this.determineRecommendation(safetyScore, issues);

		return {
			passed: recommendation !== "reject",
			safetyScore,
			recommendation,
			issues,
			suggestions: this.generateSuggestions(issues),
			validatedAt: Date.now(),
		};
	}

	/**
	 * Validate a generated subagent directly.
	 */
	validateSubagent(subagent: GeneratedSubagent): ValidationResult {
		const issues: ValidationIssue[] = [];
		let baseScore = subagent.confidence * 0.7 + 0.3;

		// Check system prompt
		this.checkDangerousPatterns(subagent.systemPrompt, "systemPrompt", issues);

		// Check for credential patterns in prompt
		this.checkCredentialPatterns(subagent.systemPrompt, "systemPrompt", issues);

		// Check allowed tools
		const dangerousTools = ["Bash", "Write", "Edit"];
		const allowedDangerous = subagent.allowedTools.filter((t) =>
			dangerousTools.includes(t)
		);
		if (allowedDangerous.length > this.config.maxRestrictedTools) {
			issues.push({
				severity: "high",
				category: "unbounded_resource",
				description: `Too many dangerous tools allowed: ${allowedDangerous.join(", ")}`,
				location: "allowedTools",
				penalty: 0.2,
			});
		}

		// Check constraints
		if (subagent.constraints.length < 2) {
			issues.push({
				severity: "medium",
				category: "missing_constraint",
				description: "Subagent has insufficient constraints",
				penalty: 0.1,
			});
		}

		// Validators and reviewers are safer
		if (subagent.role === "validator" || subagent.role === "reviewer") {
			baseScore += 0.05;
		}

		const totalPenalty = issues.reduce((sum, i) => sum + i.penalty, 0);
		const safetyScore = Math.max(0, Math.min(1, baseScore - totalPenalty));
		const recommendation = this.determineRecommendation(safetyScore, issues);

		return {
			passed: recommendation !== "reject",
			safetyScore,
			recommendation,
			issues,
			suggestions: this.generateSuggestions(issues),
			validatedAt: Date.now(),
		};
	}

	/**
	 * Validate a prompt optimization directly.
	 */
	validatePromptOptimization(
		optimization: PromptOptimization
	): ValidationResult {
		const issues: ValidationIssue[] = [];
		const baseScore = optimization.confidence * 0.8 + 0.2;

		// Check proposed text
		this.checkDangerousPatterns(
			optimization.proposedText,
			"proposedText",
			issues
		);
		this.checkCredentialPatterns(
			optimization.proposedText,
			"proposedText",
			issues
		);

		// Prompt optimizations are generally safer
		// But replace operations need more scrutiny
		if (optimization.insertionPoint === "replace") {
			if (!optimization.originalSegment) {
				issues.push({
					severity: "medium",
					category: "irreversible",
					description: "Replace operation without original segment",
					penalty: 0.1,
				});
			}
		}

		// Check for always-review patterns
		for (const pattern of this.config.alwaysReviewPatterns) {
			if (pattern.test(optimization.proposedText)) {
				issues.push({
					severity: "low",
					category: "destructive_operation",
					description: `Contains pattern requiring review: ${pattern.source}`,
					penalty: 0.05,
				});
			}
		}

		const totalPenalty = issues.reduce((sum, i) => sum + i.penalty, 0);
		const safetyScore = Math.max(0, baseScore - totalPenalty);
		const recommendation = this.determineRecommendation(safetyScore, issues);

		return {
			passed: recommendation !== "reject",
			safetyScore,
			recommendation,
			issues,
			suggestions: this.generateSuggestions(issues),
			validatedAt: Date.now(),
		};
	}

	/**
	 * Batch validate multiple improvements.
	 */
	validateBatch(improvements: Improvement[]): BatchValidationResult {
		const results = new Map<string, ValidationResult>();
		let passed = 0;
		let autoDeployable = 0;
		let needsReview = 0;
		let rejected = 0;

		for (const improvement of improvements) {
			const result = this.validate(improvement);
			results.set(improvement.improvementId, result);

			if (result.passed) {
				passed++;
				if (result.recommendation === "auto_deploy") {
					autoDeployable++;
				} else {
					needsReview++;
				}
			} else {
				rejected++;
			}
		}

		return {
			total: improvements.length,
			passed,
			autoDeployable,
			needsReview,
			rejected,
			results,
		};
	}

	/**
	 * Check if improvement is safe for auto-deploy.
	 */
	isAutoDeployable(improvement: Improvement): boolean {
		const result = this.validate(improvement);
		return result.recommendation === "auto_deploy";
	}

	/**
	 * Get safety score for improvement.
	 */
	getSafetyScore(improvement: Improvement): number {
		const result = this.validate(improvement);
		return result.safetyScore;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Validate skill improvement data.
	 */
	private validateSkillImprovement(
		data: ImprovementData,
		issues: ValidationIssue[]
	): void {
		// Check implementation
		if (data.implementation) {
			this.checkDangerousPatterns(data.implementation, "implementation", issues);
			this.checkCredentialPatterns(data.implementation, "implementation", issues);
		}

		// Check description
		this.checkDangerousPatterns(data.description, "description", issues);
	}

	/**
	 * Validate subagent improvement data.
	 */
	private validateSubagentImprovement(
		data: ImprovementData,
		issues: ValidationIssue[]
	): void {
		// Check system prompt
		if (data.systemPrompt) {
			this.checkDangerousPatterns(data.systemPrompt, "systemPrompt", issues);
			this.checkCredentialPatterns(data.systemPrompt, "systemPrompt", issues);
		}

		// Check description
		this.checkDangerousPatterns(data.description, "description", issues);
	}

	/**
	 * Validate prompt improvement data.
	 */
	private validatePromptImprovement(
		data: ImprovementData,
		issues: ValidationIssue[]
	): void {
		// Check revised prompt
		if (data.revisedPrompt) {
			this.checkDangerousPatterns(data.revisedPrompt, "revisedPrompt", issues);
			this.checkCredentialPatterns(data.revisedPrompt, "revisedPrompt", issues);
		}

		// Check original vs revised
		if (data.originalPrompt && data.revisedPrompt) {
			// Check for drastic changes
			const similarity = this.calculateSimilarity(
				data.originalPrompt,
				data.revisedPrompt
			);
			if (similarity < 0.3) {
				issues.push({
					severity: "medium",
					category: "irreversible",
					description: "Drastic change from original prompt",
					location: "revisedPrompt",
					penalty: 0.1,
				});
			}
		}
	}

	/**
	 * Check text for dangerous patterns.
	 */
	private checkDangerousPatterns(
		text: string,
		location: string,
		issues: ValidationIssue[]
	): void {
		for (const pattern of this.config.dangerousPatterns) {
			if (pattern.test(text)) {
				issues.push({
					severity: "critical",
					category: "dangerous_command",
					description: `Dangerous pattern detected: ${pattern.source}`,
					location,
					penalty: 0.5,
				});
			}
		}

		// Also check always-review patterns
		for (const pattern of this.config.alwaysReviewPatterns) {
			if (pattern.test(text)) {
				issues.push({
					severity: "medium",
					category: "destructive_operation",
					description: `Pattern requires review: ${pattern.source}`,
					location,
					penalty: 0.1,
				});
			}
		}
	}

	/**
	 * Check text for credential patterns.
	 */
	private checkCredentialPatterns(
		text: string,
		location: string,
		issues: ValidationIssue[]
	): void {
		const credentialPatterns = [
			/api[_-]?key/i,
			/secret[_-]?key/i,
			/password/i,
			/credential/i,
			/bearer\s+[a-zA-Z0-9]/i,
			/sk-[a-zA-Z0-9]{20,}/i, // OpenAI-style keys
			/sk-ant-[a-zA-Z0-9]{20,}/i, // Anthropic keys
			/ghp_[a-zA-Z0-9]{36}/i, // GitHub tokens
			/eyJ[a-zA-Z0-9]{20,}/i, // JWT tokens
		];

		for (const pattern of credentialPatterns) {
			if (pattern.test(text)) {
				issues.push({
					severity: "critical",
					category: "credential_exposure",
					description: `Potential credential pattern: ${pattern.source}`,
					location,
					penalty: 0.4,
				});
			}
		}
	}

	/**
	 * Calculate simple text similarity.
	 */
	private calculateSimilarity(text1: string, text2: string): number {
		const words1 = new Set(text1.toLowerCase().split(/\s+/));
		const words2 = new Set(text2.toLowerCase().split(/\s+/));

		const intersection = [...words1].filter((w) => words2.has(w)).length;
		const union = new Set([...words1, ...words2]).size;

		return union > 0 ? intersection / union : 0;
	}

	/**
	 * Determine deployment recommendation.
	 */
	private determineRecommendation(
		safetyScore: number,
		issues: ValidationIssue[]
	): ValidationResult["recommendation"] {
		// Critical issues always require rejection
		const hasCritical = issues.some((i) => i.severity === "critical");
		if (hasCritical) {
			return "reject";
		}

		// Check thresholds
		if (safetyScore >= this.config.autoDeployThreshold) {
			// Even high scores need review if high-severity issues exist
			const hasHigh = issues.some((i) => i.severity === "high");
			if (hasHigh) {
				return "human_review";
			}
			return "auto_deploy";
		}

		if (safetyScore >= this.config.humanReviewThreshold) {
			return "human_review";
		}

		return "reject";
	}

	/**
	 * Generate suggestions for fixing issues.
	 */
	private generateSuggestions(issues: ValidationIssue[]): string[] {
		const suggestions: string[] = [];

		for (const issue of issues) {
			switch (issue.category) {
				case "dangerous_command":
					suggestions.push(
						`Remove or sandbox dangerous command: ${issue.description}`
					);
					break;
				case "credential_exposure":
					suggestions.push(
						`Remove credential reference and use environment variables instead`
					);
					break;
				case "destructive_operation":
					suggestions.push(
						`Add user confirmation before destructive operation`
					);
					break;
				case "unbounded_resource":
					suggestions.push(
						`Limit resource access or add rate limiting`
					);
					break;
				case "irreversible":
					suggestions.push(
						`Add backup/restore capability or undo mechanism`
					);
					break;
				case "missing_constraint":
					suggestions.push(
						`Add safety constraint: user approval, reversibility, or logging`
					);
					break;
			}
		}

		// Deduplicate
		return [...new Set(suggestions)];
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a safety validator with optional configuration.
 */
export function createSafetyValidator(
	config: Partial<SafetyValidatorConfig> = {}
): SafetyValidator {
	return new SafetyValidator(config);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Quick check if text contains dangerous patterns.
 */
export function containsDangerousPatterns(text: string): boolean {
	const validator = new SafetyValidator();
	const issues: ValidationIssue[] = [];
	// @ts-expect-error - accessing private method for utility
	validator.checkDangerousPatterns(text, "text", issues);
	return issues.some((i) => i.severity === "critical");
}

/**
 * Quick check if improvement is safe.
 */
export function isImprovementSafe(improvement: Improvement): boolean {
	const validator = new SafetyValidator();
	const result = validator.validate(improvement);
	return result.passed;
}
