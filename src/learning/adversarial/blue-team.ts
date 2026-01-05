/**
 * BlueTeam - Defend and validate generated improvements.
 *
 * Provides defense capabilities:
 * - Apply mitigations for known vulnerabilities
 * - Validate improvements meet safety criteria
 * - Harden implementations
 * - Monitor for anomalies
 *
 * Goal: Make improvements robust before deployment.
 */

import type { Improvement } from "../interaction/types.js";
import type { GeneratedSkill } from "../generator/skill-generator.js";
import type { GeneratedSubagent } from "../generator/subagent-composer.js";
import type { RedTeamReport, AttackType } from "./red-team.js";

// ============================================================================
// Types
// ============================================================================

export interface BlueTeamConfig {
	/** Minimum safety score to pass */
	minSafetyScore: number;
	/** Auto-apply mitigations */
	autoMitigate: boolean;
	/** Maximum allowed vulnerabilities */
	maxVulnerabilities: number;
	/** Enable strict mode (zero tolerance) */
	strictMode: boolean;
}

export const DEFAULT_BLUE_CONFIG: BlueTeamConfig = {
	minSafetyScore: 0.8,
	autoMitigate: true,
	maxVulnerabilities: 2,
	strictMode: false,
};

export type MitigationType =
	| "input_validation"
	| "output_sanitization"
	| "resource_limiting"
	| "sequence_enforcement"
	| "access_control"
	| "error_handling"
	| "logging";

export interface Mitigation {
	/** Mitigation ID */
	mitigationId: string;
	/** Mitigation type */
	type: MitigationType;
	/** Mitigation name */
	name: string;
	/** Description */
	description: string;
	/** Attacks this mitigates */
	mitigatesAttacks: AttackType[];
	/** Implementation hint */
	implementation: string;
	/** Effectiveness (0-1) */
	effectiveness: number;
}

export interface MitigationApplication {
	/** Mitigation applied */
	mitigation: Mitigation;
	/** Where applied */
	appliedTo: string;
	/** Before state */
	before?: string;
	/** After state */
	after?: string;
	/** Success */
	success: boolean;
}

export interface DefenseReport {
	/** Target ID */
	targetId: string;
	/** Red team report (if available) */
	redTeamReport?: RedTeamReport;
	/** Safety score (0-1, higher = safer) */
	safetyScore: number;
	/** Whether it passed validation */
	passed: boolean;
	/** Reason for pass/fail */
	reason: string;
	/** Mitigations applied */
	mitigationsApplied: MitigationApplication[];
	/** Remaining vulnerabilities */
	remainingVulnerabilities: number;
	/** Recommendations */
	recommendations: string[];
	/** Timestamp */
	timestamp: number;
}

export interface ValidationRule {
	/** Rule ID */
	ruleId: string;
	/** Rule name */
	name: string;
	/** Rule description */
	description: string;
	/** Check function */
	check: (target: unknown) => ValidationResult;
	/** Severity if violated (0-1) */
	severity: number;
}

export interface ValidationResult {
	/** Whether rule passed */
	passed: boolean;
	/** Details */
	details: string;
	/** Evidence if failed */
	evidence?: string;
}

// ============================================================================
// BlueTeam Class
// ============================================================================

export class BlueTeam {
	private config: BlueTeamConfig;
	private mitigations: Mitigation[];
	private validationRules: ValidationRule[];

	constructor(config: Partial<BlueTeamConfig> = {}) {
		this.config = { ...DEFAULT_BLUE_CONFIG, ...config };
		this.mitigations = this.buildMitigationLibrary();
		this.validationRules = this.buildValidationRules();
	}

	/**
	 * Defend a skill after red team attack.
	 */
	defendSkill(
		skill: GeneratedSkill,
		redTeamReport: RedTeamReport
	): DefenseReport {
		// Calculate initial safety score from red team report
		const initialSafetyScore = 1 - redTeamReport.vulnerabilityScore;

		// Select mitigations
		const mitigations = this.selectMitigations(redTeamReport);

		// Apply mitigations if enabled
		const applications: MitigationApplication[] = [];
		if (this.config.autoMitigate) {
			for (const mitigation of mitigations) {
				const application = this.applyMitigationToSkill(skill, mitigation);
				applications.push(application);
			}
		}

		// Calculate final safety score
		const mitigationBoost = applications
			.filter((a) => a.success)
			.reduce((sum, a) => sum + a.mitigation.effectiveness * 0.1, 0);
		const safetyScore = Math.min(1, initialSafetyScore + mitigationBoost);

		// Determine pass/fail
		const remainingVulnerabilities =
			redTeamReport.vulnerabilitiesFound -
			applications.filter((a) => a.success).length;

		const passed = this.evaluatePass(safetyScore, remainingVulnerabilities);

		return {
			targetId: skill.name,
			redTeamReport,
			safetyScore,
			passed,
			reason: this.getPassReason(passed, safetyScore, remainingVulnerabilities),
			mitigationsApplied: applications,
			remainingVulnerabilities: Math.max(0, remainingVulnerabilities),
			recommendations: this.getRecommendations(
				redTeamReport,
				applications,
				safetyScore
			),
			timestamp: Date.now(),
		};
	}

	/**
	 * Defend a subagent after red team attack.
	 */
	defendSubagent(
		subagent: GeneratedSubagent,
		redTeamReport: RedTeamReport
	): DefenseReport {
		const initialSafetyScore = 1 - redTeamReport.vulnerabilityScore;

		// Subagents get stricter validation
		const adjustedScore = this.config.strictMode
			? initialSafetyScore * 0.9
			: initialSafetyScore;

		const mitigations = this.selectMitigations(redTeamReport);
		const applications: MitigationApplication[] = [];

		if (this.config.autoMitigate) {
			for (const mitigation of mitigations) {
				const application = this.applyMitigationToSubagent(
					subagent,
					mitigation
				);
				applications.push(application);
			}
		}

		const mitigationBoost = applications
			.filter((a) => a.success)
			.reduce((sum, a) => sum + a.mitigation.effectiveness * 0.1, 0);
		const safetyScore = Math.min(1, adjustedScore + mitigationBoost);

		const remainingVulnerabilities =
			redTeamReport.vulnerabilitiesFound -
			applications.filter((a) => a.success).length;

		const passed = this.evaluatePass(safetyScore, remainingVulnerabilities);

		return {
			targetId: subagent.name,
			redTeamReport,
			safetyScore,
			passed,
			reason: this.getPassReason(passed, safetyScore, remainingVulnerabilities),
			mitigationsApplied: applications,
			remainingVulnerabilities: Math.max(0, remainingVulnerabilities),
			recommendations: this.getRecommendations(
				redTeamReport,
				applications,
				safetyScore
			),
			timestamp: Date.now(),
		};
	}

	/**
	 * Validate improvement without red team report.
	 */
	validateImprovement(improvement: Improvement): DefenseReport {
		const results: Array<{ rule: ValidationRule; result: ValidationResult }> =
			[];

		// Run validation rules
		for (const rule of this.validationRules) {
			const result = rule.check(improvement);
			results.push({ rule, result });
		}

		// Calculate safety score
		const failedWeight = results
			.filter((r) => !r.result.passed)
			.reduce((sum, r) => sum + r.rule.severity, 0);
		const totalWeight = results.reduce((sum, r) => sum + r.rule.severity, 0);
		const safetyScore = totalWeight > 0 ? 1 - failedWeight / totalWeight : 1;

		const failedRules = results.filter((r) => !r.result.passed);
		const passed =
			safetyScore >= this.config.minSafetyScore &&
			failedRules.length <= this.config.maxVulnerabilities;

		return {
			targetId: improvement.improvementId,
			safetyScore,
			passed,
			reason: passed
				? "Passed validation rules"
				: `Failed ${failedRules.length} validation rules`,
			mitigationsApplied: [],
			remainingVulnerabilities: failedRules.length,
			recommendations: failedRules.map(
				(r) => `Fix: ${r.rule.name} - ${r.result.details}`
			),
			timestamp: Date.now(),
		};
	}

	/**
	 * Get mitigation library.
	 */
	getMitigationLibrary(): Mitigation[] {
		return [...this.mitigations];
	}

	/**
	 * Get validation rules.
	 */
	getValidationRules(): ValidationRule[] {
		return [...this.validationRules];
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Build mitigation library.
	 */
	private buildMitigationLibrary(): Mitigation[] {
		return [
			{
				mitigationId: "mit_input_validation",
				type: "input_validation",
				name: "Input Validation",
				description: "Validate and sanitize all inputs",
				mitigatesAttacks: ["edge_case", "injection", "boundary_violation"],
				implementation:
					"Add input validation before processing: check types, lengths, formats",
				effectiveness: 0.8,
			},
			{
				mitigationId: "mit_output_sanitization",
				type: "output_sanitization",
				name: "Output Sanitization",
				description: "Sanitize outputs to prevent injection",
				mitigatesAttacks: ["injection"],
				implementation:
					"Escape special characters in outputs, use parameterized queries",
				effectiveness: 0.9,
			},
			{
				mitigationId: "mit_resource_limiting",
				type: "resource_limiting",
				name: "Resource Limiting",
				description: "Limit resource usage to prevent exhaustion",
				mitigatesAttacks: ["resource_exhaustion"],
				implementation: "Add timeouts, memory limits, and iteration caps",
				effectiveness: 0.85,
			},
			{
				mitigationId: "mit_sequence_enforcement",
				type: "sequence_enforcement",
				name: "Sequence Enforcement",
				description: "Enforce correct operation sequence",
				mitigatesAttacks: ["sequence_manipulation"],
				implementation: "Track state machine, validate preconditions",
				effectiveness: 0.75,
			},
			{
				mitigationId: "mit_access_control",
				type: "access_control",
				name: "Access Control",
				description: "Restrict access to sensitive resources",
				mitigatesAttacks: ["injection"],
				implementation:
					"Use allowlists, validate paths, restrict tool access",
				effectiveness: 0.9,
			},
			{
				mitigationId: "mit_error_handling",
				type: "error_handling",
				name: "Error Handling",
				description: "Handle errors gracefully without exposing info",
				mitigatesAttacks: ["edge_case", "state_corruption"],
				implementation:
					"Catch exceptions, provide safe fallbacks, log securely",
				effectiveness: 0.7,
			},
			{
				mitigationId: "mit_logging",
				type: "logging",
				name: "Security Logging",
				description: "Log security-relevant events",
				mitigatesAttacks: [], // Detection, not prevention
				implementation: "Log all security events, monitor for anomalies",
				effectiveness: 0.5,
			},
		];
	}

	/**
	 * Build validation rules.
	 */
	private buildValidationRules(): ValidationRule[] {
		return [
			{
				ruleId: "rule_no_dangerous_commands",
				name: "No Dangerous Commands",
				description: "Check for dangerous shell commands",
				check: (target) => {
					const str = JSON.stringify(target).toLowerCase();
					const dangerous = ["rm -rf", "dd if=", "mkfs", ":(){"];
					const found = dangerous.find((d) => str.includes(d));
					return {
						passed: !found,
						details: found
							? `Contains dangerous command: ${found}`
							: "No dangerous commands found",
					};
				},
				severity: 1.0,
			},
			{
				ruleId: "rule_no_credential_access",
				name: "No Credential Access",
				description: "Check for credential access patterns",
				check: (target) => {
					const str = JSON.stringify(target);
					const patterns = [
						"API_KEY",
						"SECRET",
						"PASSWORD",
						"CREDENTIAL",
						"TOKEN",
					];
					const found = patterns.find((p) =>
						str.toUpperCase().includes(p)
					);
					return {
						passed: !found,
						details: found
							? `Contains credential pattern: ${found}`
							: "No credential access patterns",
					};
				},
				severity: 0.9,
			},
			{
				ruleId: "rule_has_constraints",
				name: "Has Safety Constraints",
				description: "Check that safety constraints are defined",
				check: (target) => {
					const str = JSON.stringify(target).toLowerCase();
					const hasConstraints =
						str.includes("constraint") ||
						str.includes("limit") ||
						str.includes("validate") ||
						str.includes("approve");
					return {
						passed: hasConstraints,
						details: hasConstraints
							? "Safety constraints found"
							: "No safety constraints defined",
					};
				},
				severity: 0.6,
			},
			{
				ruleId: "rule_no_unbounded_loops",
				name: "No Unbounded Loops",
				description: "Check for potentially unbounded loops",
				check: (target) => {
					const str = JSON.stringify(target).toLowerCase();
					const risky =
						str.includes("while (true)") ||
						str.includes("for (;;)") ||
						(str.includes("while") && !str.includes("break"));
					return {
						passed: !risky,
						details: risky
							? "Potentially unbounded loop detected"
							: "No unbounded loops",
					};
				},
				severity: 0.7,
			},
			{
				ruleId: "rule_reasonable_length",
				name: "Reasonable Length",
				description: "Check that content is reasonably sized",
				check: (target) => {
					const str = JSON.stringify(target);
					const reasonable = str.length < 50000;
					return {
						passed: reasonable,
						details: reasonable
							? "Content length is reasonable"
							: `Content too large: ${str.length} chars`,
					};
				},
				severity: 0.4,
			},
		];
	}

	/**
	 * Select mitigations for vulnerabilities found.
	 */
	private selectMitigations(report: RedTeamReport): Mitigation[] {
		const attackTypes = new Set<AttackType>();

		for (const outcome of report.outcomes) {
			if (outcome.result === "vulnerable" || outcome.result === "partial") {
				attackTypes.add(outcome.attack.type);
			}
		}

		return this.mitigations.filter((m) =>
			m.mitigatesAttacks.some((a) => attackTypes.has(a))
		);
	}

	/**
	 * Apply mitigation to skill.
	 */
	private applyMitigationToSkill(
		skill: GeneratedSkill,
		mitigation: Mitigation
	): MitigationApplication {
		// Simulate applying mitigation by adding constraint
		const before = skill.constraints.join(", ");

		switch (mitigation.type) {
			case "input_validation":
				skill.constraints.push("Validate all inputs before processing");
				break;
			case "output_sanitization":
				skill.constraints.push("Sanitize outputs before display");
				break;
			case "resource_limiting":
				skill.constraints.push("Apply timeout and resource limits");
				break;
			case "sequence_enforcement":
				skill.constraints.push("Validate operation sequence");
				break;
			case "access_control":
				skill.constraints.push("Restrict access to allowed resources only");
				break;
			case "error_handling":
				skill.constraints.push("Handle errors gracefully with safe fallbacks");
				break;
			case "logging":
				skill.constraints.push("Log security-relevant events");
				break;
		}

		return {
			mitigation,
			appliedTo: "skill.constraints",
			before,
			after: skill.constraints.join(", "),
			success: true,
		};
	}

	/**
	 * Apply mitigation to subagent.
	 */
	private applyMitigationToSubagent(
		subagent: GeneratedSubagent,
		mitigation: Mitigation
	): MitigationApplication {
		const before = subagent.constraints.join(", ");

		switch (mitigation.type) {
			case "input_validation":
				subagent.constraints.push("Validate all inputs before processing");
				break;
			case "access_control":
				// Remove dangerous tools
				const dangerousTools = ["Bash"];
				if (
					mitigation.effectiveness > 0.8 &&
					subagent.role !== "fixer"
				) {
					for (const tool of dangerousTools) {
						const idx = subagent.allowedTools.indexOf(tool);
						if (idx >= 0) {
							subagent.allowedTools.splice(idx, 1);
							subagent.restrictedTools.push(tool);
						}
					}
				}
				subagent.constraints.push("Restricted tool access applied");
				break;
			case "resource_limiting":
				subagent.constraints.push("Operation timeout: 60 seconds");
				break;
			default:
				subagent.constraints.push(mitigation.implementation);
		}

		return {
			mitigation,
			appliedTo: "subagent.constraints",
			before,
			after: subagent.constraints.join(", "),
			success: true,
		};
	}

	/**
	 * Evaluate if target passes.
	 */
	private evaluatePass(
		safetyScore: number,
		remainingVulnerabilities: number
	): boolean {
		if (this.config.strictMode) {
			return safetyScore >= 0.9 && remainingVulnerabilities === 0;
		}

		return (
			safetyScore >= this.config.minSafetyScore &&
			remainingVulnerabilities <= this.config.maxVulnerabilities
		);
	}

	/**
	 * Get pass/fail reason.
	 */
	private getPassReason(
		passed: boolean,
		safetyScore: number,
		remainingVulnerabilities: number
	): string {
		if (passed) {
			return `Passed: safety score ${(safetyScore * 100).toFixed(1)}%, ${remainingVulnerabilities} remaining vulnerabilities`;
		}

		const reasons: string[] = [];
		if (safetyScore < this.config.minSafetyScore) {
			reasons.push(
				`safety score ${(safetyScore * 100).toFixed(1)}% below threshold ${(this.config.minSafetyScore * 100).toFixed(0)}%`
			);
		}
		if (remainingVulnerabilities > this.config.maxVulnerabilities) {
			reasons.push(
				`${remainingVulnerabilities} vulnerabilities exceed max ${this.config.maxVulnerabilities}`
			);
		}

		return `Failed: ${reasons.join(", ")}`;
	}

	/**
	 * Get recommendations.
	 */
	private getRecommendations(
		report: RedTeamReport,
		applications: MitigationApplication[],
		safetyScore: number
	): string[] {
		const recommendations: string[] = [];

		// Add recommendations from red team
		recommendations.push(...report.recommendations);

		// Add unmitigated issues
		const mitigatedTypes = new Set(
			applications
				.filter((a) => a.success)
				.flatMap((a) => a.mitigation.mitigatesAttacks)
		);

		for (const outcome of report.outcomes) {
			if (
				outcome.result === "vulnerable" &&
				!mitigatedTypes.has(outcome.attack.type)
			) {
				recommendations.push(`Address: ${outcome.attack.name}`);
			}
		}

		// Safety score improvement
		if (safetyScore < 0.9) {
			recommendations.push(
				"Consider adding more safety constraints for higher safety score"
			);
		}

		// Deduplicate
		return [...new Set(recommendations)];
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a blue team defender with optional configuration.
 */
export function createBlueTeam(config: Partial<BlueTeamConfig> = {}): BlueTeam {
	return new BlueTeam(config);
}
