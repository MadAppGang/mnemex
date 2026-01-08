/**
 * WorkflowDetector - Identifies repetitive tool sequences for automation.
 *
 * Detects patterns like:
 * - Read → Edit → Bash(test) - developer workflow
 * - Glob → Read → Read → Read - exploration pattern
 * - Edit → Edit → Edit - iterative refinement
 *
 * High-value workflows are candidates for:
 * - Skill generation (automate the sequence)
 * - Subagent creation (handle the workflow autonomously)
 */

import type { ToolEvent, DetectedPattern } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface WorkflowDetectorConfig {
	/** Minimum sequence length to consider */
	minSequenceLength: number;
	/** Maximum sequence length to track */
	maxSequenceLength: number;
	/** Minimum occurrences to report */
	minOccurrences: number;
	/** Time window (ms) to consider events part of same workflow */
	workflowWindowMs: number;
	/** Minimum automation potential to flag */
	minAutomationPotential: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowDetectorConfig = {
	minSequenceLength: 2,
	maxSequenceLength: 8,
	minOccurrences: 3,
	workflowWindowMs: 10 * 60 * 1000, // 10 minutes
	minAutomationPotential: 0.5,
};

export interface Workflow {
	/** Tool sequence pattern */
	sequence: string[];
	/** How many times this workflow occurred */
	occurrences: number;
	/** Sessions where this workflow occurred */
	sessionIds: string[];
	/** Average time to complete workflow (ms) */
	avgDurationMs: number;
	/** Success rate of the workflow */
	successRate: number;
	/** Automation potential (0-1) */
	automationPotential: number;
	/** Category of workflow */
	category: "exploration" | "modification" | "testing" | "mixed";
	/** Example tool use IDs */
	exampleToolUseIds: string[];
}

export interface WorkflowAnalysis {
	workflows: Workflow[];
	totalSequences: number;
	topAutomatable: Workflow[];
	categoryBreakdown: Record<string, number>;
}

// ============================================================================
// WorkflowDetector Class
// ============================================================================

export class WorkflowDetector {
	private config: WorkflowDetectorConfig;

	constructor(config: Partial<WorkflowDetectorConfig> = {}) {
		this.config = { ...DEFAULT_WORKFLOW_CONFIG, ...config };
	}

	/**
	 * Detect workflows from tool events.
	 */
	detect(events: ToolEvent[]): WorkflowAnalysis {
		// Group events by session
		const sessionEvents = this.groupBySession(events);

		// Extract all sequences
		const allSequences = this.extractAllSequences(sessionEvents);

		// Count sequence occurrences
		const sequenceCounts = this.countSequences(allSequences);

		// Convert to Workflow objects
		const workflows = this.createWorkflows(sequenceCounts, allSequences);

		// Sort by automation potential
		const topAutomatable = workflows
			.filter(
				(w) => w.automationPotential >= this.config.minAutomationPotential,
			)
			.sort((a, b) => b.automationPotential - a.automationPotential)
			.slice(0, 20);

		// Category breakdown
		const categoryBreakdown: Record<string, number> = {
			exploration: 0,
			modification: 0,
			testing: 0,
			mixed: 0,
		};
		for (const w of workflows) {
			categoryBreakdown[w.category]++;
		}

		return {
			workflows,
			totalSequences: allSequences.length,
			topAutomatable,
			categoryBreakdown,
		};
	}

	/**
	 * Convert workflows to DetectedPattern format.
	 */
	toPatterns(analysis: WorkflowAnalysis): DetectedPattern[] {
		return analysis.workflows
			.filter(
				(w) => w.automationPotential >= this.config.minAutomationPotential,
			)
			.map((w) => ({
				patternId: `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
				patternType: "workflow" as const,
				patternHash: w.sequence.join("→"),
				patternData: {
					description: `${w.sequence.join(" → ")} (${w.occurrences}x, ${(w.automationPotential * 100).toFixed(0)}% automatable)`,
					sequence: w.sequence,
					occurrences: w.occurrences,
					avgDurationMs: w.avgDurationMs,
					successRate: w.successRate,
					automationPotential: w.automationPotential,
					category: w.category,
				},
				occurrenceCount: w.occurrences,
				lastSeen: Date.now(),
				severity: w.automationPotential > 0.8 ? "low" : "medium",
				projectScope: undefined,
			}));
	}

	/**
	 * Suggest skills from high-value workflows.
	 */
	suggestSkills(analysis: WorkflowAnalysis): Array<{
		workflow: Workflow;
		skillName: string;
		skillDescription: string;
		priority: "high" | "medium" | "low";
	}> {
		return analysis.topAutomatable
			.filter((w) => w.automationPotential >= 0.7 && w.occurrences >= 5)
			.map((w) => ({
				workflow: w,
				skillName: this.generateSkillName(w),
				skillDescription: this.generateSkillDescription(w),
				priority:
					w.automationPotential >= 0.9
						? "high"
						: w.automationPotential >= 0.8
							? "medium"
							: "low",
			}));
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Group events by session.
	 */
	private groupBySession(events: ToolEvent[]): Map<string, ToolEvent[]> {
		const groups = new Map<string, ToolEvent[]>();

		for (const event of events) {
			const existing = groups.get(event.sessionId) || [];
			existing.push(event);
			groups.set(event.sessionId, existing);
		}

		// Sort events within each session by timestamp
		for (const [, sessionEvents] of groups) {
			sessionEvents.sort((a, b) => a.timestamp - b.timestamp);
		}

		return groups;
	}

	/**
	 * Extract all tool sequences from sessions.
	 */
	private extractAllSequences(sessionEvents: Map<string, ToolEvent[]>): Array<{
		sequence: string[];
		sessionId: string;
		events: ToolEvent[];
		duration: number;
		successCount: number;
	}> {
		const results: Array<{
			sequence: string[];
			sessionId: string;
			events: ToolEvent[];
			duration: number;
			successCount: number;
		}> = [];

		for (const [sessionId, events] of sessionEvents) {
			// Split into workflow windows
			const windows = this.splitIntoWindows(events);

			for (const windowEvents of windows) {
				// Extract n-grams of different lengths
				for (
					let len = this.config.minSequenceLength;
					len <= Math.min(this.config.maxSequenceLength, windowEvents.length);
					len++
				) {
					for (let i = 0; i <= windowEvents.length - len; i++) {
						const slice = windowEvents.slice(i, i + len);
						results.push({
							sequence: slice.map((e) => e.toolName),
							sessionId,
							events: slice,
							duration: slice[slice.length - 1].timestamp - slice[0].timestamp,
							successCount: slice.filter((e) => e.success).length,
						});
					}
				}
			}
		}

		return results;
	}

	/**
	 * Split events into workflow windows based on time gaps.
	 */
	private splitIntoWindows(events: ToolEvent[]): ToolEvent[][] {
		if (events.length === 0) return [];

		const windows: ToolEvent[][] = [];
		let currentWindow: ToolEvent[] = [events[0]];

		for (let i = 1; i < events.length; i++) {
			const timeDelta = events[i].timestamp - events[i - 1].timestamp;

			if (timeDelta > this.config.workflowWindowMs) {
				// Start new window
				if (currentWindow.length >= this.config.minSequenceLength) {
					windows.push(currentWindow);
				}
				currentWindow = [events[i]];
			} else {
				currentWindow.push(events[i]);
			}
		}

		// Don't forget last window
		if (currentWindow.length >= this.config.minSequenceLength) {
			windows.push(currentWindow);
		}

		return windows;
	}

	/**
	 * Count sequence occurrences.
	 */
	private countSequences(
		sequences: Array<{
			sequence: string[];
			sessionId: string;
			events: ToolEvent[];
			duration: number;
			successCount: number;
		}>,
	): Map<string, typeof sequences> {
		const counts = new Map<string, typeof sequences>();

		for (const seq of sequences) {
			const key = seq.sequence.join("→");
			const existing = counts.get(key) || [];
			existing.push(seq);
			counts.set(key, existing);
		}

		return counts;
	}

	/**
	 * Create Workflow objects from counted sequences.
	 */
	private createWorkflows(
		sequenceCounts: Map<
			string,
			Array<{
				sequence: string[];
				sessionId: string;
				events: ToolEvent[];
				duration: number;
				successCount: number;
			}>
		>,
		allSequences: Array<{
			sequence: string[];
			sessionId: string;
			events: ToolEvent[];
			duration: number;
			successCount: number;
		}>,
	): Workflow[] {
		const workflows: Workflow[] = [];

		for (const [, instances] of sequenceCounts) {
			if (instances.length < this.config.minOccurrences) {
				continue;
			}

			const sequence = instances[0].sequence;
			const sessionIds = [...new Set(instances.map((i) => i.sessionId))];
			const avgDuration =
				instances.reduce((sum, i) => sum + i.duration, 0) / instances.length;
			const totalSuccess = instances.reduce(
				(sum, i) => sum + i.successCount,
				0,
			);
			const totalEvents = instances.reduce(
				(sum, i) => sum + i.events.length,
				0,
			);
			const successRate = totalSuccess / totalEvents;

			const automationPotential = this.calculateAutomationPotential(
				sequence,
				instances.length,
				sessionIds.length,
				successRate,
				avgDuration,
			);

			const category = this.categorizeWorkflow(sequence);

			workflows.push({
				sequence,
				occurrences: instances.length,
				sessionIds,
				avgDurationMs: avgDuration,
				successRate,
				automationPotential,
				category,
				exampleToolUseIds: instances
					.slice(0, 3)
					.flatMap((i) => i.events.map((e) => e.toolUseId)),
			});
		}

		return workflows.sort((a, b) => b.occurrences - a.occurrences);
	}

	/**
	 * Calculate automation potential for a workflow.
	 */
	private calculateAutomationPotential(
		sequence: string[],
		occurrences: number,
		sessionCount: number,
		successRate: number,
		avgDurationMs: number,
	): number {
		// Factors that increase automation potential:
		// 1. High frequency (occurs often)
		const frequencyScore = Math.min(1, occurrences / 20);

		// 2. Cross-session (used by multiple sessions)
		const crossSessionScore = Math.min(1, sessionCount / 5);

		// 3. High success rate (reliable)
		const reliabilityScore = successRate;

		// 4. Reasonable duration (not too long)
		const durationScore =
			avgDurationMs < 30000 ? 1 : avgDurationMs < 60000 ? 0.7 : 0.4;

		// 5. Contains automatable tools
		const automationFriendlyTools = ["Read", "Glob", "Grep", "Edit", "Write"];
		const automationToolRatio =
			sequence.filter((t) => automationFriendlyTools.includes(t)).length /
			sequence.length;

		// 6. Sequence is not too long
		const lengthScore =
			sequence.length <= 4 ? 1 : sequence.length <= 6 ? 0.7 : 0.4;

		// Weighted combination
		return (
			frequencyScore * 0.25 +
			crossSessionScore * 0.15 +
			reliabilityScore * 0.25 +
			durationScore * 0.1 +
			automationToolRatio * 0.15 +
			lengthScore * 0.1
		);
	}

	/**
	 * Categorize a workflow by its tools.
	 */
	private categorizeWorkflow(
		sequence: string[],
	): "exploration" | "modification" | "testing" | "mixed" {
		const readTools = ["Read", "Glob", "Grep"];
		const writeTools = ["Edit", "Write"];
		const testTools = ["Bash"]; // Often used for testing

		const readCount = sequence.filter((t) => readTools.includes(t)).length;
		const writeCount = sequence.filter((t) => writeTools.includes(t)).length;
		const testCount = sequence.filter((t) => testTools.includes(t)).length;

		const total = sequence.length;

		if (readCount / total > 0.7) {
			return "exploration";
		}
		if (writeCount / total > 0.5) {
			return "modification";
		}
		if (testCount > 0 && writeCount > 0) {
			return "testing";
		}

		return "mixed";
	}

	/**
	 * Generate a skill name from workflow.
	 */
	private generateSkillName(workflow: Workflow): string {
		const category = workflow.category;
		const tools = workflow.sequence.slice(0, 2).join("-").toLowerCase();

		const prefixes: Record<string, string> = {
			exploration: "explore",
			modification: "modify",
			testing: "test",
			mixed: "workflow",
		};

		return `auto-${prefixes[category]}-${tools}`;
	}

	/**
	 * Generate a skill description from workflow.
	 */
	private generateSkillDescription(workflow: Workflow): string {
		const sequence = workflow.sequence.join(" → ");
		const frequency = workflow.occurrences;
		const duration = Math.round(workflow.avgDurationMs / 1000);

		return `Auto-generated skill from pattern: ${sequence}. Observed ${frequency} times, avg ${duration}s.`;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a workflow detector with optional configuration.
 */
export function createWorkflowDetector(
	config: Partial<WorkflowDetectorConfig> = {},
): WorkflowDetector {
	return new WorkflowDetector(config);
}
