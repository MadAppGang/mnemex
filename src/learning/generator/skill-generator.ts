/**
 * SkillGenerator - Creates skill specifications from detected patterns.
 *
 * When workflows or error patterns are detected frequently, this module
 * generates skill specifications that can automate the workflow or
 * prevent the error pattern.
 *
 * Generated skills include:
 * - Name and description
 * - Implementation steps
 * - Trigger conditions
 * - Safety constraints
 */

import type { DetectedPattern, Improvement, ImprovementData } from "../interaction/types.js";
import type { Workflow } from "../analysis/workflow-detector.js";
import type { ErrorCluster } from "../analysis/error-clusterer.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillGeneratorConfig {
	/** Minimum automation potential to generate skill */
	minAutomationPotential: number;
	/** Minimum occurrences to generate skill */
	minOccurrences: number;
	/** Minimum success rate for workflow skills */
	minSuccessRate: number;
	/** Maximum skill name length */
	maxSkillNameLength: number;
}

export const DEFAULT_SKILL_CONFIG: SkillGeneratorConfig = {
	minAutomationPotential: 0.7,
	minOccurrences: 5,
	minSuccessRate: 0.8,
	maxSkillNameLength: 50,
};

export interface GeneratedSkill {
	/** Skill name (kebab-case) */
	name: string;
	/** Human-readable description */
	description: string;
	/** When this skill should trigger */
	triggerCondition: string;
	/** Implementation steps */
	implementation: string[];
	/** Safety constraints */
	constraints: string[];
	/** Source pattern that inspired this skill */
	sourcePattern: DetectedPattern | null;
	/** Confidence score (0-1) */
	confidence: number;
	/** Estimated impact (0-1) */
	estimatedImpact: number;
}

export interface SkillGenerationResult {
	skills: GeneratedSkill[];
	skippedPatterns: Array<{
		pattern: DetectedPattern;
		reason: string;
	}>;
}

// ============================================================================
// SkillGenerator Class
// ============================================================================

export class SkillGenerator {
	private config: SkillGeneratorConfig;

	constructor(config: Partial<SkillGeneratorConfig> = {}) {
		this.config = { ...DEFAULT_SKILL_CONFIG, ...config };
	}

	/**
	 * Generate skills from detected patterns.
	 */
	generateFromPatterns(patterns: DetectedPattern[]): SkillGenerationResult {
		const skills: GeneratedSkill[] = [];
		const skippedPatterns: Array<{ pattern: DetectedPattern; reason: string }> = [];

		for (const pattern of patterns) {
			// Skip non-workflow patterns
			if (pattern.patternType !== "workflow") {
				skippedPatterns.push({
					pattern,
					reason: `Pattern type '${pattern.patternType}' not supported for skill generation`,
				});
				continue;
			}

			// Check automation potential
			const automationPotential = pattern.patternData.automationPotential ?? 0;
			if (automationPotential < this.config.minAutomationPotential) {
				skippedPatterns.push({
					pattern,
					reason: `Automation potential ${automationPotential.toFixed(2)} below threshold ${this.config.minAutomationPotential}`,
				});
				continue;
			}

			// Check occurrences
			if (pattern.occurrenceCount < this.config.minOccurrences) {
				skippedPatterns.push({
					pattern,
					reason: `Occurrences ${pattern.occurrenceCount} below threshold ${this.config.minOccurrences}`,
				});
				continue;
			}

			// Check success rate if available
			const successRate = pattern.patternData.successRate ?? 1;
			if (successRate < this.config.minSuccessRate) {
				skippedPatterns.push({
					pattern,
					reason: `Success rate ${successRate.toFixed(2)} below threshold ${this.config.minSuccessRate}`,
				});
				continue;
			}

			// Generate skill from pattern
			const skill = this.generateSkillFromPattern(pattern);
			skills.push(skill);
		}

		return { skills, skippedPatterns };
	}

	/**
	 * Generate skills from workflows.
	 */
	generateFromWorkflows(workflows: Workflow[]): GeneratedSkill[] {
		return workflows
			.filter((w) =>
				w.automationPotential >= this.config.minAutomationPotential &&
				w.occurrences >= this.config.minOccurrences &&
				w.successRate >= this.config.minSuccessRate
			)
			.map((w) => this.generateSkillFromWorkflow(w));
	}

	/**
	 * Generate defensive skills from error clusters.
	 */
	generateDefensiveSkills(clusters: ErrorCluster[]): GeneratedSkill[] {
		return clusters
			.filter((c) => c.members.length >= this.config.minOccurrences)
			.map((c) => this.generateDefensiveSkill(c));
	}

	/**
	 * Convert generated skill to Improvement proposal.
	 */
	toImprovement(skill: GeneratedSkill, patternId: string): Improvement {
		const now = Date.now();

		const improvementData: ImprovementData = {
			name: skill.name,
			description: skill.description,
			implementation: this.formatImplementation(skill),
			evidence: {
				patternId,
				occurrences: skill.sourcePattern?.occurrenceCount ?? 0,
				confidence: skill.confidence,
			},
		};

		return {
			improvementId: `skill_${now}_${Math.random().toString(36).substr(2, 9)}`,
			patternId,
			improvementType: "skill",
			improvementData,
			status: "proposed",
			safetyScore: this.calculateSafetyScore(skill),
			impactScore: skill.estimatedImpact,
			createdAt: now,
		};
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Generate skill from a pattern.
	 */
	private generateSkillFromPattern(pattern: DetectedPattern): GeneratedSkill {
		const sequence = pattern.patternData.sequence ?? pattern.patternData.toolSequence ?? [];
		const name = this.generateSkillName(sequence, pattern.patternType);
		const description = this.generateDescription(pattern);

		return {
			name,
			description,
			triggerCondition: this.generateTriggerCondition(sequence),
			implementation: this.generateImplementationSteps(sequence),
			constraints: this.generateConstraints(sequence),
			sourcePattern: pattern,
			confidence: pattern.patternData.confidence ?? 0.8,
			estimatedImpact: this.estimateImpact(pattern),
		};
	}

	/**
	 * Generate skill from a workflow.
	 */
	private generateSkillFromWorkflow(workflow: Workflow): GeneratedSkill {
		const name = this.generateSkillName(workflow.sequence, "workflow");

		return {
			name,
			description: `Auto-generated skill from workflow pattern. ${workflow.sequence.join(" → ")}. Observed ${workflow.occurrences} times with ${(workflow.successRate * 100).toFixed(0)}% success rate.`,
			triggerCondition: this.generateTriggerCondition(workflow.sequence),
			implementation: this.generateImplementationSteps(workflow.sequence),
			constraints: this.generateConstraints(workflow.sequence),
			sourcePattern: null,
			confidence: workflow.successRate,
			estimatedImpact: workflow.automationPotential,
		};
	}

	/**
	 * Generate defensive skill from error cluster.
	 */
	private generateDefensiveSkill(cluster: ErrorCluster): GeneratedSkill {
		const name = `prevent-${cluster.errorType}-${cluster.tools[0]?.toLowerCase() ?? "unknown"}`;

		return {
			name: name.substring(0, this.config.maxSkillNameLength),
			description: `Defensive skill to prevent ${cluster.errorType} errors. Based on ${cluster.members.length} observed failures with ${cluster.tools.join(", ")}.`,
			triggerCondition: `Before ${cluster.tools.join(" or ")} execution`,
			implementation: this.generateDefensiveImplementation(cluster),
			constraints: [
				"Run validation before tool execution",
				"Fail early with clear error message",
				"Log prevention for learning",
			],
			sourcePattern: null,
			confidence: cluster.cohesion,
			estimatedImpact: cluster.frequency,
		};
	}

	/**
	 * Generate skill name from sequence.
	 */
	private generateSkillName(sequence: string[], patternType: string): string {
		if (sequence.length === 0) {
			return `auto-${patternType}`;
		}

		// Create name from first and last tools
		const first = sequence[0].toLowerCase();
		const last = sequence[sequence.length - 1].toLowerCase();

		let name: string;
		if (sequence.length <= 2) {
			name = `auto-${first}-${last}`;
		} else {
			name = `auto-${first}-to-${last}`;
		}

		// Ensure valid kebab-case
		name = name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

		return name.substring(0, this.config.maxSkillNameLength);
	}

	/**
	 * Generate description from pattern.
	 */
	private generateDescription(pattern: DetectedPattern): string {
		const sequence = pattern.patternData.sequence ?? pattern.patternData.toolSequence ?? [];
		const occurrences = pattern.occurrenceCount;
		const automation = pattern.patternData.automationPotential ?? 0;

		return `Auto-generated skill from detected workflow pattern. ` +
			`Sequence: ${sequence.join(" → ")}. ` +
			`Observed ${occurrences} times. ` +
			`Automation potential: ${(automation * 100).toFixed(0)}%.`;
	}

	/**
	 * Generate trigger condition.
	 */
	private generateTriggerCondition(sequence: string[]): string {
		if (sequence.length === 0) {
			return "Manual invocation";
		}

		const firstTool = sequence[0];
		return `When user initiates ${firstTool} operation that matches common pattern`;
	}

	/**
	 * Generate implementation steps.
	 */
	private generateImplementationSteps(sequence: string[]): string[] {
		const steps: string[] = [];

		for (let i = 0; i < sequence.length; i++) {
			const tool = sequence[i];
			const step = `Step ${i + 1}: Execute ${tool}`;
			steps.push(step);

			// Add conditional based on tool
			if (tool === "Edit" || tool === "Write") {
				steps.push(`  - Verify changes before committing`);
			} else if (tool === "Bash") {
				steps.push(`  - Check command exit code`);
				steps.push(`  - Handle errors gracefully`);
			} else if (tool === "Read" || tool === "Glob") {
				steps.push(`  - Validate file exists`);
			}
		}

		steps.push("Final: Report completion status");

		return steps;
	}

	/**
	 * Generate defensive implementation.
	 */
	private generateDefensiveImplementation(cluster: ErrorCluster): string[] {
		const steps: string[] = [];

		switch (cluster.suggestedCategory) {
			case "validation":
				steps.push("1. Validate input parameters");
				steps.push("2. Check required fields are present");
				steps.push("3. Verify data types and formats");
				break;
			case "permission":
				steps.push("1. Check file/resource permissions");
				steps.push("2. Verify user has required access");
				steps.push("3. Request permission if needed");
				break;
			case "timeout":
				steps.push("1. Set reasonable timeout limits");
				steps.push("2. Implement retry with backoff");
				steps.push("3. Provide progress feedback");
				break;
			case "logic":
				steps.push("1. Validate preconditions");
				steps.push("2. Check for edge cases");
				steps.push("3. Verify state consistency");
				break;
			default:
				steps.push("1. Log operation details");
				steps.push("2. Validate inputs");
				steps.push("3. Handle errors gracefully");
		}

		return steps;
	}

	/**
	 * Generate constraints for skill.
	 */
	private generateConstraints(sequence: string[]): string[] {
		const constraints: string[] = [
			"User must approve before execution",
			"All changes must be reversible",
		];

		// Add tool-specific constraints
		const hasBash = sequence.includes("Bash");
		const hasWrite = sequence.includes("Write") || sequence.includes("Edit");

		if (hasBash) {
			constraints.push("No destructive system commands");
			constraints.push("Sandbox execution when possible");
		}

		if (hasWrite) {
			constraints.push("Create backup before modification");
			constraints.push("Validate file content before write");
		}

		return constraints;
	}

	/**
	 * Estimate impact of skill.
	 */
	private estimateImpact(pattern: DetectedPattern): number {
		const occurrences = pattern.occurrenceCount;
		const automation = pattern.patternData.automationPotential ?? 0;
		const success = pattern.patternData.successRate ?? 1;

		// Impact = frequency * automation potential * reliability
		const baseImpact = Math.min(1, occurrences / 50);
		return baseImpact * automation * success;
	}

	/**
	 * Calculate safety score for skill.
	 */
	private calculateSafetyScore(skill: GeneratedSkill): number {
		let score = 1.0;

		// Reduce score for dangerous tools
		const dangerousTools = ["Bash", "Write", "Edit"];
		const sequence = skill.sourcePattern?.patternData.sequence ?? [];

		for (const tool of sequence) {
			if (dangerousTools.includes(tool)) {
				score *= 0.8;
			}
		}

		// Increase score for constraints
		score *= Math.min(1.2, 1 + skill.constraints.length * 0.05);

		// Cap at 1.0
		return Math.min(1.0, score);
	}

	/**
	 * Format implementation for storage.
	 */
	private formatImplementation(skill: GeneratedSkill): string {
		const lines: string[] = [
			`# ${skill.name}`,
			"",
			`## Description`,
			skill.description,
			"",
			`## Trigger`,
			skill.triggerCondition,
			"",
			`## Implementation`,
			...skill.implementation.map((s) => `- ${s}`),
			"",
			`## Constraints`,
			...skill.constraints.map((c) => `- ${c}`),
		];

		return lines.join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a skill generator with optional configuration.
 */
export function createSkillGenerator(
	config: Partial<SkillGeneratorConfig> = {}
): SkillGenerator {
	return new SkillGenerator(config);
}
