/**
 * RedTeam - Attack generated improvements to find vulnerabilities.
 *
 * Simulates adversarial conditions:
 * - Edge case inputs
 * - Malformed data
 * - Security attack patterns
 * - Resource exhaustion
 * - Unexpected sequences
 *
 * Goal: Find weaknesses before deployment.
 */

import type { Improvement } from "../interaction/types.js";
import type { GeneratedSkill } from "../generator/skill-generator.js";
import type { GeneratedSubagent } from "../generator/subagent-composer.js";

// ============================================================================
// Types
// ============================================================================

export interface RedTeamConfig {
	/** Maximum attack iterations */
	maxIterations: number;
	/** Attack intensity (0-1) */
	intensity: number;
	/** Enable security-focused attacks */
	securityFocus: boolean;
	/** Enable resource exhaustion tests */
	resourceTests: boolean;
	/** Timeout for each attack (ms) */
	attackTimeoutMs: number;
}

export const DEFAULT_RED_CONFIG: RedTeamConfig = {
	maxIterations: 50,
	intensity: 0.7,
	securityFocus: true,
	resourceTests: true,
	attackTimeoutMs: 5000,
};

export type AttackType =
	| "edge_case"
	| "malformed_input"
	| "injection"
	| "resource_exhaustion"
	| "sequence_manipulation"
	| "boundary_violation"
	| "state_corruption";

export type AttackResult = "vulnerable" | "resistant" | "partial" | "error";

export interface Attack {
	/** Attack ID */
	attackId: string;
	/** Attack type */
	type: AttackType;
	/** Attack name */
	name: string;
	/** Attack description */
	description: string;
	/** Attack payload */
	payload: AttackPayload;
	/** Expected vulnerability if attack succeeds */
	expectedVulnerability: string;
	/** Severity if vulnerable (0-1) */
	severity: number;
}

export interface AttackPayload {
	/** Input data for attack */
	input?: string;
	/** Tool sequence for sequence attacks */
	toolSequence?: string[];
	/** Parameters for parameterized attacks */
	parameters?: Record<string, unknown>;
	/** Attack-specific context */
	context?: Record<string, string>;
}

export interface AttackOutcome {
	/** Attack that was run */
	attack: Attack;
	/** Result of attack */
	result: AttackResult;
	/** Details about the outcome */
	details: string;
	/** Evidence of vulnerability (if found) */
	evidence?: string;
	/** Time taken (ms) */
	durationMs: number;
	/** Whether attack timed out */
	timedOut: boolean;
}

export interface RedTeamReport {
	/** Target improvement ID */
	targetId: string;
	/** Total attacks run */
	totalAttacks: number;
	/** Vulnerabilities found */
	vulnerabilitiesFound: number;
	/** Partial vulnerabilities */
	partialVulnerabilities: number;
	/** Resistant count */
	resistant: number;
	/** Error count */
	errors: number;
	/** Attack outcomes */
	outcomes: AttackOutcome[];
	/** Overall vulnerability score (0=safe, 1=very vulnerable) */
	vulnerabilityScore: number;
	/** Critical vulnerabilities */
	criticalVulnerabilities: string[];
	/** Recommendations */
	recommendations: string[];
	/** Timestamp */
	timestamp: number;
}

// ============================================================================
// RedTeam Class
// ============================================================================

export class RedTeam {
	private config: RedTeamConfig;
	private attackLibrary: Attack[];

	constructor(config: Partial<RedTeamConfig> = {}) {
		this.config = { ...DEFAULT_RED_CONFIG, ...config };
		this.attackLibrary = this.buildAttackLibrary();
	}

	/**
	 * Attack a generated skill.
	 */
	attackSkill(skill: GeneratedSkill): RedTeamReport {
		const attacks = this.selectAttacksForSkill(skill);
		return this.runAttacks(skill.name, attacks, skill);
	}

	/**
	 * Attack a generated subagent.
	 */
	attackSubagent(subagent: GeneratedSubagent): RedTeamReport {
		const attacks = this.selectAttacksForSubagent(subagent);
		return this.runAttacks(subagent.name, attacks, subagent);
	}

	/**
	 * Attack an improvement (any type).
	 */
	attackImprovement(improvement: Improvement): RedTeamReport {
		const attacks = this.selectAttacksForImprovement(improvement);
		return this.runAttacks(improvement.improvementId, attacks, improvement);
	}

	/**
	 * Get attack library.
	 */
	getAttackLibrary(): Attack[] {
		return [...this.attackLibrary];
	}

	/**
	 * Add custom attack.
	 */
	addAttack(attack: Attack): void {
		this.attackLibrary.push(attack);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Build the attack library.
	 */
	private buildAttackLibrary(): Attack[] {
		const attacks: Attack[] = [];

		// Edge case attacks
		attacks.push(
			{
				attackId: "edge_empty_input",
				type: "edge_case",
				name: "Empty Input",
				description: "Test with empty or null input",
				payload: { input: "" },
				expectedVulnerability: "Crashes or errors on empty input",
				severity: 0.6,
			},
			{
				attackId: "edge_large_input",
				type: "edge_case",
				name: "Large Input",
				description: "Test with very large input",
				payload: { input: "x".repeat(100000) },
				expectedVulnerability: "Memory issues or slow response",
				severity: 0.5,
			},
			{
				attackId: "edge_special_chars",
				type: "edge_case",
				name: "Special Characters",
				description: "Test with special characters and unicode",
				payload: { input: "αβγ\x00\n\r\t🔥" },
				expectedVulnerability: "Encoding errors or injection",
				severity: 0.7,
			},
		);

		// Injection attacks
		if (this.config.securityFocus) {
			attacks.push(
				{
					attackId: "inject_command",
					type: "injection",
					name: "Command Injection",
					description: "Attempt to inject shell commands",
					payload: { input: "; rm -rf / #" },
					expectedVulnerability: "Command execution",
					severity: 1.0,
				},
				{
					attackId: "inject_path_traversal",
					type: "injection",
					name: "Path Traversal",
					description: "Attempt to access files outside allowed paths",
					payload: { input: "../../../etc/passwd" },
					expectedVulnerability: "File access outside sandbox",
					severity: 0.9,
				},
				{
					attackId: "inject_env_var",
					type: "injection",
					name: "Environment Variable",
					description: "Attempt to access environment variables",
					payload: { input: "$ANTHROPIC_API_KEY" },
					expectedVulnerability: "Credential exposure",
					severity: 1.0,
				},
				{
					attackId: "inject_template",
					type: "injection",
					name: "Template Injection",
					description: "Attempt template/string interpolation",
					payload: { input: "${process.env.SECRET}" },
					expectedVulnerability: "Code execution via template",
					severity: 0.9,
				},
			);
		}

		// Resource exhaustion attacks
		if (this.config.resourceTests) {
			attacks.push(
				{
					attackId: "resource_deep_recursion",
					type: "resource_exhaustion",
					name: "Deep Recursion",
					description: "Trigger deep recursion",
					payload: { parameters: { depth: 10000 } },
					expectedVulnerability: "Stack overflow",
					severity: 0.6,
				},
				{
					attackId: "resource_infinite_loop",
					type: "resource_exhaustion",
					name: "Infinite Loop",
					description: "Trigger infinite loop condition",
					payload: { parameters: { condition: "always_true" } },
					expectedVulnerability: "CPU exhaustion",
					severity: 0.7,
				},
				{
					attackId: "resource_memory",
					type: "resource_exhaustion",
					name: "Memory Exhaustion",
					description: "Allocate excessive memory",
					payload: { parameters: { allocSize: 1000000000 } },
					expectedVulnerability: "Memory exhaustion",
					severity: 0.7,
				},
			);
		}

		// Sequence manipulation attacks
		attacks.push(
			{
				attackId: "seq_out_of_order",
				type: "sequence_manipulation",
				name: "Out of Order Sequence",
				description: "Call steps in wrong order",
				payload: { toolSequence: ["step3", "step1", "step2"] },
				expectedVulnerability: "State corruption from wrong order",
				severity: 0.5,
			},
			{
				attackId: "seq_skip_steps",
				type: "sequence_manipulation",
				name: "Skip Steps",
				description: "Skip required steps",
				payload: { toolSequence: ["step1", "step3"] }, // skip step2
				expectedVulnerability: "Undefined behavior from skipped validation",
				severity: 0.6,
			},
			{
				attackId: "seq_repeat_steps",
				type: "sequence_manipulation",
				name: "Repeat Steps",
				description: "Repeat steps unexpectedly",
				payload: { toolSequence: ["step1", "step1", "step1"] },
				expectedVulnerability: "Duplicate operations",
				severity: 0.4,
			},
		);

		// Boundary violation attacks
		attacks.push(
			{
				attackId: "boundary_negative",
				type: "boundary_violation",
				name: "Negative Values",
				description: "Use negative values where positive expected",
				payload: { parameters: { count: -1, index: -100 } },
				expectedVulnerability: "Array underflow or invalid state",
				severity: 0.5,
			},
			{
				attackId: "boundary_overflow",
				type: "boundary_violation",
				name: "Integer Overflow",
				description: "Use very large numbers",
				payload: { parameters: { value: Number.MAX_SAFE_INTEGER + 1 } },
				expectedVulnerability: "Integer overflow",
				severity: 0.4,
			},
		);

		// State corruption attacks
		attacks.push(
			{
				attackId: "state_concurrent",
				type: "state_corruption",
				name: "Concurrent Access",
				description: "Simulate concurrent access",
				payload: { parameters: { concurrent: true } },
				expectedVulnerability: "Race condition",
				severity: 0.6,
			},
			{
				attackId: "state_partial_failure",
				type: "state_corruption",
				name: "Partial Failure",
				description: "Fail midway through operation",
				payload: { parameters: { failAt: "middle" } },
				expectedVulnerability: "Inconsistent state",
				severity: 0.5,
			},
		);

		return attacks;
	}

	/**
	 * Select relevant attacks for a skill.
	 */
	private selectAttacksForSkill(skill: GeneratedSkill): Attack[] {
		const selected: Attack[] = [];

		// Include edge cases always
		selected.push(...this.attackLibrary.filter((a) => a.type === "edge_case"));

		// Include injection attacks if skill has Bash
		const hasBash = skill.implementation.some(
			(s) => s.includes("Bash") || s.includes("command"),
		);
		if (hasBash) {
			selected.push(
				...this.attackLibrary.filter((a) => a.type === "injection"),
			);
		}

		// Include sequence attacks for multi-step skills
		if (skill.implementation.length > 2) {
			selected.push(
				...this.attackLibrary.filter((a) => a.type === "sequence_manipulation"),
			);
		}

		// Apply intensity filter
		return this.applyIntensityFilter(selected);
	}

	/**
	 * Select relevant attacks for a subagent.
	 */
	private selectAttacksForSubagent(subagent: GeneratedSubagent): Attack[] {
		const selected: Attack[] = [];

		// Include edge cases always
		selected.push(...this.attackLibrary.filter((a) => a.type === "edge_case"));

		// Include injection attacks if subagent has Bash access
		if (subagent.allowedTools.includes("Bash")) {
			selected.push(
				...this.attackLibrary.filter((a) => a.type === "injection"),
			);
		}

		// Include resource attacks for subagents (they run autonomously)
		selected.push(
			...this.attackLibrary.filter((a) => a.type === "resource_exhaustion"),
		);

		// Include state attacks
		selected.push(
			...this.attackLibrary.filter((a) => a.type === "state_corruption"),
		);

		return this.applyIntensityFilter(selected);
	}

	/**
	 * Select attacks for generic improvement.
	 */
	private selectAttacksForImprovement(improvement: Improvement): Attack[] {
		// Base set of attacks
		const selected = this.attackLibrary.filter(
			(a) =>
				a.type === "edge_case" ||
				a.type === "boundary_violation" ||
				(this.config.securityFocus && a.type === "injection"),
		);

		return this.applyIntensityFilter(selected);
	}

	/**
	 * Apply intensity filter.
	 */
	private applyIntensityFilter(attacks: Attack[]): Attack[] {
		// Higher intensity = more attacks
		const targetCount = Math.ceil(attacks.length * this.config.intensity);
		return attacks.slice(0, Math.min(targetCount, this.config.maxIterations));
	}

	/**
	 * Run attacks and generate report.
	 */
	private runAttacks(
		targetId: string,
		attacks: Attack[],
		target: unknown,
	): RedTeamReport {
		const outcomes: AttackOutcome[] = [];
		const criticalVulnerabilities: string[] = [];

		for (const attack of attacks) {
			const outcome = this.runSingleAttack(attack, target);
			outcomes.push(outcome);

			if (outcome.result === "vulnerable" && attack.severity >= 0.8) {
				criticalVulnerabilities.push(
					`${attack.name}: ${attack.expectedVulnerability}`,
				);
			}
		}

		// Calculate scores
		const vulnerable = outcomes.filter((o) => o.result === "vulnerable").length;
		const partial = outcomes.filter((o) => o.result === "partial").length;
		const resistant = outcomes.filter((o) => o.result === "resistant").length;
		const errors = outcomes.filter((o) => o.result === "error").length;

		// Weighted vulnerability score
		const totalWeight = outcomes.reduce(
			(sum, o) =>
				sum +
				(o.result === "vulnerable"
					? o.attack.severity
					: o.result === "partial"
						? o.attack.severity * 0.3
						: 0),
			0,
		);
		const maxWeight = outcomes.reduce((sum, o) => sum + o.attack.severity, 0);
		const vulnerabilityScore = maxWeight > 0 ? totalWeight / maxWeight : 0;

		// Generate recommendations
		const recommendations = this.generateRecommendations(outcomes);

		return {
			targetId,
			totalAttacks: attacks.length,
			vulnerabilitiesFound: vulnerable,
			partialVulnerabilities: partial,
			resistant,
			errors,
			outcomes,
			vulnerabilityScore,
			criticalVulnerabilities,
			recommendations,
			timestamp: Date.now(),
		};
	}

	/**
	 * Run a single attack.
	 */
	private runSingleAttack(attack: Attack, target: unknown): AttackOutcome {
		const startTime = Date.now();

		try {
			// Simulate attack (in production, would actually test the target)
			const result = this.simulateAttack(attack, target);

			return {
				attack,
				result,
				details: this.getResultDetails(result, attack),
				evidence:
					result === "vulnerable" ? this.getEvidence(attack) : undefined,
				durationMs: Date.now() - startTime,
				timedOut: false,
			};
		} catch (error) {
			return {
				attack,
				result: "error",
				details: `Attack error: ${error instanceof Error ? error.message : String(error)}`,
				durationMs: Date.now() - startTime,
				timedOut: Date.now() - startTime >= this.config.attackTimeoutMs,
			};
		}
	}

	/**
	 * Simulate attack (static analysis based).
	 */
	private simulateAttack(attack: Attack, target: unknown): AttackResult {
		const targetStr = JSON.stringify(target).toLowerCase();
		const payload = attack.payload;

		// Check for obvious vulnerabilities based on target content
		switch (attack.type) {
			case "injection":
				// Check if target might execute input without sanitization
				if (
					targetStr.includes("bash") &&
					!targetStr.includes("sanitize") &&
					!targetStr.includes("escape")
				) {
					return "vulnerable";
				}
				if (
					attack.attackId === "inject_env_var" &&
					(targetStr.includes("process.env") ||
						targetStr.includes("environment"))
				) {
					return "partial";
				}
				break;

			case "edge_case":
				// Most targets should handle edge cases
				if (
					attack.attackId === "edge_empty_input" &&
					!targetStr.includes("empty") &&
					!targetStr.includes("required")
				) {
					return "partial";
				}
				break;

			case "resource_exhaustion":
				// Check for resource limits
				if (
					!targetStr.includes("timeout") &&
					!targetStr.includes("limit") &&
					!targetStr.includes("max")
				) {
					return "partial";
				}
				break;

			case "sequence_manipulation":
				// Check for sequence validation
				if (
					!targetStr.includes("order") &&
					!targetStr.includes("sequence") &&
					!targetStr.includes("step")
				) {
					return "partial";
				}
				break;
		}

		return "resistant";
	}

	/**
	 * Get result details.
	 */
	private getResultDetails(result: AttackResult, attack: Attack): string {
		switch (result) {
			case "vulnerable":
				return `Target is vulnerable to ${attack.name}: ${attack.expectedVulnerability}`;
			case "partial":
				return `Target may be partially vulnerable to ${attack.name}`;
			case "resistant":
				return `Target appears resistant to ${attack.name}`;
			case "error":
				return `Error while testing ${attack.name}`;
		}
	}

	/**
	 * Get evidence of vulnerability.
	 */
	private getEvidence(attack: Attack): string {
		return `Attack payload: ${JSON.stringify(attack.payload).substring(0, 200)}`;
	}

	/**
	 * Generate recommendations from outcomes.
	 */
	private generateRecommendations(outcomes: AttackOutcome[]): string[] {
		const recommendations: string[] = [];
		const vulnerableTypes = new Set<AttackType>();

		for (const outcome of outcomes) {
			if (outcome.result === "vulnerable" || outcome.result === "partial") {
				vulnerableTypes.add(outcome.attack.type);
			}
		}

		if (vulnerableTypes.has("injection")) {
			recommendations.push("Add input sanitization and command escaping");
		}
		if (vulnerableTypes.has("edge_case")) {
			recommendations.push("Add validation for empty and malformed inputs");
		}
		if (vulnerableTypes.has("resource_exhaustion")) {
			recommendations.push("Add timeouts and resource limits");
		}
		if (vulnerableTypes.has("sequence_manipulation")) {
			recommendations.push("Add sequence validation and state checks");
		}
		if (vulnerableTypes.has("boundary_violation")) {
			recommendations.push("Add bounds checking for numeric inputs");
		}
		if (vulnerableTypes.has("state_corruption")) {
			recommendations.push(
				"Add transaction-like rollback for partial failures",
			);
		}

		return recommendations;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a red team attacker with optional configuration.
 */
export function createRedTeam(config: Partial<RedTeamConfig> = {}): RedTeam {
	return new RedTeam(config);
}
