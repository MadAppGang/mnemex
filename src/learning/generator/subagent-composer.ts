/**
 * SubagentComposer - Creates subagent specifications from error patterns.
 *
 * When similar errors cluster together frequently, this module generates
 * subagent specifications that can handle the error prevention or
 * provide specialized assistance.
 *
 * Generated subagents include:
 * - Role and system prompt
 * - Trigger conditions
 * - Tool restrictions
 * - Safety constraints
 */

import type { DetectedPattern, Improvement, ImprovementData } from "../interaction/types.js";
import type { ErrorCluster } from "../analysis/error-clusterer.js";

// ============================================================================
// Types
// ============================================================================

export interface SubagentComposerConfig {
	/** Minimum error cluster size to generate subagent */
	minClusterSize: number;
	/** Minimum cohesion score for cluster */
	minCohesion: number;
	/** Maximum subagent name length */
	maxNameLength: number;
	/** Maximum system prompt length */
	maxPromptLength: number;
}

export const DEFAULT_COMPOSER_CONFIG: SubagentComposerConfig = {
	minClusterSize: 5,
	minCohesion: 0.6,
	maxNameLength: 40,
	maxPromptLength: 2000,
};

export interface GeneratedSubagent {
	/** Subagent name (kebab-case) */
	name: string;
	/** Role description */
	role: "reviewer" | "validator" | "assistant" | "fixer";
	/** System prompt */
	systemPrompt: string;
	/** When this subagent should trigger */
	triggerCondition: string;
	/** Tools the subagent can use */
	allowedTools: string[];
	/** Tools the subagent should avoid */
	restrictedTools: string[];
	/** Safety constraints */
	constraints: string[];
	/** Source error cluster */
	sourceCluster: ErrorCluster | null;
	/** Source pattern */
	sourcePattern: DetectedPattern | null;
	/** Confidence score (0-1) */
	confidence: number;
	/** Estimated impact (0-1) */
	estimatedImpact: number;
}

export interface SubagentCompositionResult {
	subagents: GeneratedSubagent[];
	skippedClusters: Array<{
		cluster: ErrorCluster;
		reason: string;
	}>;
}

// ============================================================================
// SubagentComposer Class
// ============================================================================

export class SubagentComposer {
	private config: SubagentComposerConfig;

	constructor(config: Partial<SubagentComposerConfig> = {}) {
		this.config = { ...DEFAULT_COMPOSER_CONFIG, ...config };
	}

	/**
	 * Generate subagents from error clusters.
	 */
	composeFromClusters(clusters: ErrorCluster[]): SubagentCompositionResult {
		const subagents: GeneratedSubagent[] = [];
		const skippedClusters: Array<{ cluster: ErrorCluster; reason: string }> = [];

		for (const cluster of clusters) {
			// Check cluster size
			if (cluster.members.length < this.config.minClusterSize) {
				skippedClusters.push({
					cluster,
					reason: `Cluster size ${cluster.members.length} below threshold ${this.config.minClusterSize}`,
				});
				continue;
			}

			// Check cohesion
			if (cluster.cohesion < this.config.minCohesion) {
				skippedClusters.push({
					cluster,
					reason: `Cohesion ${cluster.cohesion.toFixed(2)} below threshold ${this.config.minCohesion}`,
				});
				continue;
			}

			// Generate subagent
			const subagent = this.composeFromCluster(cluster);
			subagents.push(subagent);
		}

		return { subagents, skippedClusters };
	}

	/**
	 * Generate subagents from error patterns.
	 */
	composeFromPatterns(patterns: DetectedPattern[]): GeneratedSubagent[] {
		return patterns
			.filter((p) => p.patternType === "error" && p.occurrenceCount >= this.config.minClusterSize)
			.map((p) => this.composeFromPattern(p));
	}

	/**
	 * Generate specialized subagents for specific error categories.
	 */
	composeSpecialized(
		category: "validation" | "permission" | "timeout" | "logic"
	): GeneratedSubagent {
		const templates: Record<string, Partial<GeneratedSubagent>> = {
			validation: {
				name: "input-validator",
				role: "validator",
				systemPrompt: this.buildValidationPrompt(),
				triggerCondition: "Before Write, Edit, or Bash tools with user-provided data",
				allowedTools: ["Read", "Glob", "Grep"],
				restrictedTools: ["Write", "Edit", "Bash"],
			},
			permission: {
				name: "permission-checker",
				role: "validator",
				systemPrompt: this.buildPermissionPrompt(),
				triggerCondition: "Before file operations on protected paths",
				allowedTools: ["Read", "Glob", "Bash"],
				restrictedTools: ["Write", "Edit"],
			},
			timeout: {
				name: "timeout-guard",
				role: "assistant",
				systemPrompt: this.buildTimeoutPrompt(),
				triggerCondition: "Before long-running operations",
				allowedTools: ["Read", "Glob"],
				restrictedTools: [],
			},
			logic: {
				name: "logic-reviewer",
				role: "reviewer",
				systemPrompt: this.buildLogicPrompt(),
				triggerCondition: "After code generation, before commit",
				allowedTools: ["Read", "Glob", "Grep"],
				restrictedTools: [],
			},
		};

		const template = templates[category];

		return {
			name: template.name ?? `${category}-handler`,
			role: template.role ?? "assistant",
			systemPrompt: template.systemPrompt ?? "",
			triggerCondition: template.triggerCondition ?? "Manual invocation",
			allowedTools: template.allowedTools ?? [],
			restrictedTools: template.restrictedTools ?? [],
			constraints: [
				"Must explain reasoning before taking action",
				"Must request user confirmation for destructive operations",
				"Must log all decisions for learning",
			],
			sourceCluster: null,
			sourcePattern: null,
			confidence: 0.9,
			estimatedImpact: 0.7,
		};
	}

	/**
	 * Convert generated subagent to Improvement proposal.
	 */
	toImprovement(subagent: GeneratedSubagent, patternId: string): Improvement {
		const now = Date.now();

		const improvementData: ImprovementData = {
			name: subagent.name,
			description: `Auto-generated subagent: ${subagent.role}. ${subagent.triggerCondition}`,
			systemPrompt: subagent.systemPrompt,
			evidence: {
				patternId,
				occurrences: subagent.sourceCluster?.members.length ?? 0,
				confidence: subagent.confidence,
			},
		};

		return {
			improvementId: `subagent_${now}_${Math.random().toString(36).substr(2, 9)}`,
			patternId,
			improvementType: "subagent",
			improvementData,
			status: "proposed",
			safetyScore: this.calculateSafetyScore(subagent),
			impactScore: subagent.estimatedImpact,
			createdAt: now,
		};
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Compose subagent from error cluster.
	 */
	private composeFromCluster(cluster: ErrorCluster): GeneratedSubagent {
		const name = this.generateName(cluster);
		const role = this.determineRole(cluster);
		const systemPrompt = this.generateSystemPrompt(cluster, role);

		return {
			name,
			role,
			systemPrompt,
			triggerCondition: this.generateTriggerCondition(cluster),
			allowedTools: this.determineAllowedTools(cluster),
			restrictedTools: cluster.tools,
			constraints: this.generateConstraints(cluster),
			sourceCluster: cluster,
			sourcePattern: null,
			confidence: cluster.cohesion,
			estimatedImpact: cluster.frequency,
		};
	}

	/**
	 * Compose subagent from pattern.
	 */
	private composeFromPattern(pattern: DetectedPattern): GeneratedSubagent {
		const name = `pattern-handler-${pattern.patternId.slice(-8)}`;
		const tools = pattern.patternData.tools ?? [];

		return {
			name: name.substring(0, this.config.maxNameLength),
			role: "reviewer",
			systemPrompt: this.generatePatternPrompt(pattern),
			triggerCondition: `When ${pattern.patternData.description}`,
			allowedTools: ["Read", "Glob", "Grep"],
			restrictedTools: tools,
			constraints: [
				"Review before allowing action",
				"Log all interventions",
				"Explain reasoning to user",
			],
			sourceCluster: null,
			sourcePattern: pattern,
			confidence: pattern.patternData.confidence ?? 0.8,
			estimatedImpact: Math.min(1, pattern.occurrenceCount / 20),
		};
	}

	/**
	 * Generate subagent name from cluster.
	 */
	private generateName(cluster: ErrorCluster): string {
		const errorType = cluster.errorType.toLowerCase();
		const primaryTool = cluster.tools[0]?.toLowerCase() ?? "general";

		let name = `${errorType}-${primaryTool}-guard`;

		// Ensure valid kebab-case
		name = name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

		return name.substring(0, this.config.maxNameLength);
	}

	/**
	 * Determine subagent role based on cluster.
	 */
	private determineRole(cluster: ErrorCluster): GeneratedSubagent["role"] {
		switch (cluster.suggestedCategory) {
			case "validation":
				return "validator";
			case "permission":
				return "validator";
			case "timeout":
				return "assistant";
			case "logic":
				return "reviewer";
			default:
				return "assistant";
		}
	}

	/**
	 * Generate system prompt for subagent.
	 */
	private generateSystemPrompt(
		cluster: ErrorCluster,
		role: GeneratedSubagent["role"]
	): string {
		const lines: string[] = [
			`# ${role.charAt(0).toUpperCase() + role.slice(1)} Subagent`,
			"",
			"## Purpose",
			`Prevent ${cluster.errorType} errors when using ${cluster.tools.join(", ")}.`,
			"",
			"## Background",
			`This subagent was auto-generated from ${cluster.members.length} observed errors ` +
				`with ${(cluster.cohesion * 100).toFixed(0)}% similarity.`,
			"",
			"## Error Pattern",
			cluster.centroid.errorMessage ?? "Unknown error pattern",
			"",
			"## Instructions",
		];

		// Add role-specific instructions
		switch (role) {
			case "validator":
				lines.push(
					"1. Validate all inputs before tool execution",
					"2. Check preconditions are met",
					"3. Reject invalid operations with clear explanation"
				);
				break;
			case "reviewer":
				lines.push(
					"1. Review proposed changes for potential issues",
					"2. Flag risky operations",
					"3. Suggest safer alternatives when possible"
				);
				break;
			case "fixer":
				lines.push(
					"1. Detect when the error pattern occurs",
					"2. Apply automatic fix if safe",
					"3. Escalate to user if fix requires confirmation"
				);
				break;
			case "assistant":
			default:
				lines.push(
					"1. Monitor for error conditions",
					"2. Provide guidance to prevent errors",
					"3. Help recover if error occurs"
				);
		}

		lines.push(
			"",
			"## Constraints",
			"- Always explain your reasoning",
			"- Request user confirmation for destructive actions",
			"- Log decisions for continuous learning"
		);

		const prompt = lines.join("\n");
		return prompt.substring(0, this.config.maxPromptLength);
	}

	/**
	 * Generate system prompt for pattern-based subagent.
	 */
	private generatePatternPrompt(pattern: DetectedPattern): string {
		const lines: string[] = [
			"# Pattern Handler Subagent",
			"",
			"## Purpose",
			`Handle detected pattern: ${pattern.patternData.description}`,
			"",
			"## Pattern Details",
			`- Type: ${pattern.patternType}`,
			`- Occurrences: ${pattern.occurrenceCount}`,
			`- Severity: ${pattern.severity}`,
			"",
			"## Instructions",
			"1. Monitor for this pattern",
			"2. Intervene when pattern is detected",
			"3. Apply appropriate remediation",
			"4. Log intervention for learning",
		];

		return lines.join("\n").substring(0, this.config.maxPromptLength);
	}

	/**
	 * Generate trigger condition from cluster.
	 */
	private generateTriggerCondition(cluster: ErrorCluster): string {
		const tools = cluster.tools.join(" or ");

		switch (cluster.suggestedCategory) {
			case "validation":
				return `Before ${tools} execution with external data`;
			case "permission":
				return `Before ${tools} execution on protected resources`;
			case "timeout":
				return `Before ${tools} execution on potentially slow operations`;
			case "logic":
				return `After ${tools} execution, before committing changes`;
			default:
				return `When ${tools} is about to execute`;
		}
	}

	/**
	 * Determine allowed tools for subagent.
	 */
	private determineAllowedTools(cluster: ErrorCluster): string[] {
		// Read-only tools are generally safe
		const safeTools = ["Read", "Glob", "Grep", "LS"];

		// Add Bash if errors are not timeout-related
		if (cluster.suggestedCategory !== "timeout") {
			safeTools.push("Bash");
		}

		return safeTools;
	}

	/**
	 * Generate constraints for subagent.
	 */
	private generateConstraints(cluster: ErrorCluster): string[] {
		const constraints: string[] = [
			"Must explain reasoning before taking action",
			"Must request user confirmation for destructive operations",
		];

		switch (cluster.suggestedCategory) {
			case "validation":
				constraints.push("Must validate all inputs before proceeding");
				constraints.push("Must reject malformed data with clear error message");
				break;
			case "permission":
				constraints.push("Must check permissions before file operations");
				constraints.push("Must not bypass security restrictions");
				break;
			case "timeout":
				constraints.push("Must set reasonable timeouts for all operations");
				constraints.push("Must provide progress feedback for long operations");
				break;
			case "logic":
				constraints.push("Must review code for common logic errors");
				constraints.push("Must flag edge cases and boundary conditions");
				break;
		}

		constraints.push("Must log all decisions for continuous learning");

		return constraints;
	}

	/**
	 * Calculate safety score for subagent.
	 */
	private calculateSafetyScore(subagent: GeneratedSubagent): number {
		let score = 1.0;

		// Reduce score for write-capable subagents
		const writeTools = ["Write", "Edit", "Bash"];
		const hasWriteTools = subagent.allowedTools.some((t) =>
			writeTools.includes(t)
		);
		if (hasWriteTools) {
			score *= 0.8;
		}

		// Reduce score for lower cohesion clusters
		if (subagent.sourceCluster) {
			score *= subagent.sourceCluster.cohesion;
		}

		// Increase score for constraints
		score *= Math.min(1.2, 1 + subagent.constraints.length * 0.05);

		// Reviewers and validators are safer
		if (subagent.role === "reviewer" || subagent.role === "validator") {
			score *= 1.1;
		}

		return Math.min(1.0, score);
	}

	// ========================================================================
	// Template Prompts
	// ========================================================================

	private buildValidationPrompt(): string {
		return `# Input Validator Subagent

## Purpose
Validate all inputs before tool execution to prevent validation errors.

## Instructions
1. Check data types and formats
2. Validate required fields are present
3. Sanitize potentially dangerous inputs
4. Reject invalid inputs with clear error message

## Validation Rules
- File paths: Must be valid, no path traversal
- Commands: Must not contain shell injection
- User input: Must be properly escaped
- JSON/YAML: Must be well-formed

## Output
Return validation result:
- VALID: Input passes all checks
- INVALID: Input fails with reason`;
	}

	private buildPermissionPrompt(): string {
		return `# Permission Checker Subagent

## Purpose
Verify permissions before file and system operations.

## Instructions
1. Check file exists and is accessible
2. Verify write permissions for modifications
3. Check directory permissions for new files
4. Validate user has necessary privileges

## Protected Paths
- System directories (/etc, /usr, /bin)
- User sensitive directories (~/.ssh, ~/.gnupg)
- Project lock files (package-lock.json, yarn.lock)

## Output
Return permission check result:
- ALLOWED: Operation permitted
- DENIED: Operation blocked with reason`;
	}

	private buildTimeoutPrompt(): string {
		return `# Timeout Guard Subagent

## Purpose
Prevent timeout errors by estimating operation duration.

## Instructions
1. Estimate operation duration
2. Set appropriate timeout
3. Provide progress feedback for long operations
4. Suggest chunking for large operations

## Duration Heuristics
- File read: ~1ms per KB
- Directory scan: ~10ms per 100 files
- Network request: 1-30s depending on endpoint
- Build/compile: Varies by project size

## Output
Return timeout recommendation:
- SAFE: Operation should complete quickly
- WARN: Operation may take time, show progress
- CHUNK: Operation should be split into parts`;
	}

	private buildLogicPrompt(): string {
		return `# Logic Reviewer Subagent

## Purpose
Review code for logic errors before committing.

## Instructions
1. Check for common logic errors
2. Validate edge cases are handled
3. Verify error handling is present
4. Ensure consistent state management

## Common Issues
- Off-by-one errors
- Null/undefined handling
- Race conditions
- Resource leaks
- Infinite loops

## Output
Return review result:
- CLEAN: No issues found
- ISSUES: List of potential problems with severity`;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a subagent composer with optional configuration.
 */
export function createSubagentComposer(
	config: Partial<SubagentComposerConfig> = {}
): SubagentComposer {
	return new SubagentComposer(config);
}
