/**
 * PatternMiner - Discovers patterns in tool sequences and error events.
 *
 * Implements two pattern mining algorithms:
 * - FP-Growth: Frequent itemset mining for co-occurring events
 * - PrefixSpan: Sequential pattern mining for tool sequences
 *
 * These algorithms identify:
 * - Repetitive error patterns (same errors occurring together)
 * - Workflow patterns (common tool sequences that could be automated)
 * - Misuse patterns (tool combinations that often fail)
 */

import type {
	ToolEvent,
	DetectedPattern,
	PatternData,
} from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface PatternMinerConfig {
	/** Minimum support threshold for FP-Growth (0-1) */
	minSupport: number;
	/** Minimum confidence for association rules (0-1) */
	minConfidence: number;
	/** Maximum pattern length */
	maxPatternLength: number;
	/** Minimum sequence length for PrefixSpan */
	minSequenceLength: number;
	/** Time window (ms) to group events into sequences */
	sequenceWindowMs: number;
}

export const DEFAULT_MINER_CONFIG: PatternMinerConfig = {
	minSupport: 0.05, // 5% of sessions must contain the pattern
	minConfidence: 0.6, // 60% confidence for rules
	maxPatternLength: 5,
	minSequenceLength: 2,
	sequenceWindowMs: 5 * 60 * 1000, // 5 minutes
};

export interface FrequentItemset {
	items: string[];
	support: number;
	count: number;
}

export interface AssociationRule {
	antecedent: string[];
	consequent: string[];
	support: number;
	confidence: number;
	lift: number;
}

export interface SequentialPattern {
	sequence: string[];
	support: number;
	count: number;
	avgDurationMs: number;
}

export interface MinedPatterns {
	frequentItemsets: FrequentItemset[];
	associationRules: AssociationRule[];
	sequentialPatterns: SequentialPattern[];
	errorPatterns: DetectedPattern[];
	workflowPatterns: DetectedPattern[];
}

// ============================================================================
// FP-Growth Implementation
// ============================================================================

/**
 * FP-Tree node for FP-Growth algorithm.
 */
class FPNode {
	item: string | undefined;
	count: number;
	parent: FPNode | undefined;
	children: Map<string, FPNode>;
	link: FPNode | undefined;

	constructor(item: string | undefined, parent: FPNode | undefined) {
		this.item = item;
		this.count = 0;
		this.parent = parent;
		this.children = new Map();
		this.link = undefined;
	}
}

/**
 * FP-Tree for efficient frequent pattern mining.
 */
class FPTree {
	root: FPNode;
	headerTable: Map<string, FPNode>;
	itemCounts: Map<string, number>;

	constructor() {
		this.root = new FPNode(undefined, undefined);
		this.headerTable = new Map();
		this.itemCounts = new Map();
	}

	/**
	 * Insert a transaction into the tree.
	 */
	insert(items: string[]): void {
		let current = this.root;

		for (const item of items) {
			// Update item counts
			this.itemCounts.set(item, (this.itemCounts.get(item) || 0) + 1);

			// Find or create child node
			let child = current.children.get(item);
			if (!child) {
				child = new FPNode(item, current);
				current.children.set(item, child);

				// Update header table
				if (this.headerTable.has(item)) {
					let node = this.headerTable.get(item)!;
					while (node.link) {
						node = node.link;
					}
					node.link = child;
				} else {
					this.headerTable.set(item, child);
				}
			}

			child.count++;
			current = child;
		}
	}

	/**
	 * Get conditional pattern base for an item.
	 */
	getConditionalPatternBase(
		item: string,
	): Array<{ path: string[]; count: number }> {
		const patterns: Array<{ path: string[]; count: number }> = [];
		let node = this.headerTable.get(item);

		while (node) {
			const path: string[] = [];
			let parent = node.parent;

			while (parent && parent.item !== undefined) {
				path.unshift(parent.item);
				parent = parent.parent;
			}

			if (path.length > 0) {
				patterns.push({ path, count: node.count });
			}

			node = node.link;
		}

		return patterns;
	}
}

// ============================================================================
// PatternMiner Class
// ============================================================================

export class PatternMiner {
	private config: PatternMinerConfig;

	constructor(config: Partial<PatternMinerConfig> = {}) {
		this.config = { ...DEFAULT_MINER_CONFIG, ...config };
	}

	/**
	 * Mine patterns from tool events.
	 */
	minePatterns(events: ToolEvent[], sessionIds: string[]): MinedPatterns {
		// Group events by session
		const sessionEvents = this.groupBySession(events);
		const totalSessions = sessionIds.length;

		// Extract itemsets (tool + outcome combinations)
		const transactions = this.extractTransactions(sessionEvents);

		// Run FP-Growth
		const frequentItemsets = this.fpGrowth(transactions, totalSessions);

		// Generate association rules
		const associationRules = this.generateRules(
			frequentItemsets,
			totalSessions,
		);

		// Extract sequences for PrefixSpan
		const sequences = this.extractSequences(sessionEvents);

		// Run PrefixSpan
		const sequentialPatterns = this.prefixSpan(sequences, totalSessions);

		// Convert to DetectedPattern format
		const errorPatterns = this.identifyErrorPatterns(
			frequentItemsets,
			associationRules,
			events,
		);
		const workflowPatterns = this.identifyWorkflowPatterns(
			sequentialPatterns,
			events,
		);

		return {
			frequentItemsets,
			associationRules,
			sequentialPatterns,
			errorPatterns,
			workflowPatterns,
		};
	}

	/**
	 * FP-Growth algorithm for frequent itemset mining.
	 */
	private fpGrowth(
		transactions: string[][],
		totalSessions: number,
	): FrequentItemset[] {
		const minSupportCount = Math.ceil(this.config.minSupport * totalSessions);
		const results: FrequentItemset[] = [];

		// Count item frequencies
		const itemCounts = new Map<string, number>();
		for (const transaction of transactions) {
			for (const item of transaction) {
				itemCounts.set(item, (itemCounts.get(item) || 0) + 1);
			}
		}

		// Filter infrequent items and sort by frequency
		const frequentItems = [...itemCounts.entries()]
			.filter(([, count]) => count >= minSupportCount)
			.sort((a, b) => b[1] - a[1])
			.map(([item]) => item);

		const frequentItemsSet = new Set(frequentItems);

		// Build FP-Tree
		const tree = new FPTree();
		for (const transaction of transactions) {
			// Filter and sort transaction items
			const filteredItems = transaction
				.filter((item) => frequentItemsSet.has(item))
				.sort((a, b) => frequentItems.indexOf(a) - frequentItems.indexOf(b));
			if (filteredItems.length > 0) {
				tree.insert(filteredItems);
			}
		}

		// Mine patterns recursively
		this.mineTree(tree, [], minSupportCount, totalSessions, results);

		return results;
	}

	/**
	 * Recursively mine FP-Tree.
	 */
	private mineTree(
		tree: FPTree,
		prefix: string[],
		minSupportCount: number,
		totalSessions: number,
		results: FrequentItemset[],
	): void {
		// Process items in reverse frequency order
		const items = [...tree.headerTable.keys()].reverse();

		for (const item of items) {
			// Create new pattern
			const newPattern = [...prefix, item];
			const count = tree.itemCounts.get(item) || 0;

			if (count >= minSupportCount) {
				results.push({
					items: newPattern,
					support: count / totalSessions,
					count,
				});

				// Build conditional FP-Tree
				if (newPattern.length < this.config.maxPatternLength) {
					const conditionalBase = tree.getConditionalPatternBase(item);
					if (conditionalBase.length > 0) {
						const conditionalTree = new FPTree();
						for (const { path, count } of conditionalBase) {
							for (let i = 0; i < count; i++) {
								conditionalTree.insert(path);
							}
						}

						// Recursively mine conditional tree
						this.mineTree(
							conditionalTree,
							newPattern,
							minSupportCount,
							totalSessions,
							results,
						);
					}
				}
			}
		}
	}

	/**
	 * Generate association rules from frequent itemsets.
	 */
	private generateRules(
		itemsets: FrequentItemset[],
		totalSessions: number,
	): AssociationRule[] {
		const rules: AssociationRule[] = [];
		const itemsetMap = new Map<string, FrequentItemset>();

		// Index itemsets by key
		for (const itemset of itemsets) {
			const key = itemset.items.slice().sort().join("|");
			itemsetMap.set(key, itemset);
		}

		// Generate rules from itemsets with 2+ items
		for (const itemset of itemsets) {
			if (itemset.items.length < 2) continue;

			// Generate all non-empty subsets as antecedents
			const subsets = this.generateSubsets(itemset.items);

			for (const antecedent of subsets) {
				if (
					antecedent.length === 0 ||
					antecedent.length === itemset.items.length
				) {
					continue;
				}

				const consequent = itemset.items.filter(
					(item) => !antecedent.includes(item),
				);

				const antecedentKey = antecedent.slice().sort().join("|");
				const antecedentItemset = itemsetMap.get(antecedentKey);

				if (antecedentItemset) {
					const confidence = itemset.support / antecedentItemset.support;

					if (confidence >= this.config.minConfidence) {
						// Calculate lift
						const consequentKey = consequent.slice().sort().join("|");
						const consequentItemset = itemsetMap.get(consequentKey);
						const expectedSupport = consequentItemset
							? antecedentItemset.support * consequentItemset.support
							: antecedentItemset.support / totalSessions;
						const lift = itemset.support / expectedSupport;

						rules.push({
							antecedent,
							consequent,
							support: itemset.support,
							confidence,
							lift,
						});
					}
				}
			}
		}

		// Sort by confidence * lift
		return rules.sort((a, b) => b.confidence * b.lift - a.confidence * a.lift);
	}

	/**
	 * PrefixSpan algorithm for sequential pattern mining.
	 */
	private prefixSpan(
		sequences: Array<{ items: string[]; duration: number }>,
		totalSessions: number,
	): SequentialPattern[] {
		const minSupportCount = Math.ceil(this.config.minSupport * totalSessions);
		const results: SequentialPattern[] = [];

		// Find frequent 1-sequences
		const itemCounts = new Map<string, number>();
		for (const seq of sequences) {
			const seen = new Set<string>();
			for (const item of seq.items) {
				if (!seen.has(item)) {
					itemCounts.set(item, (itemCounts.get(item) || 0) + 1);
					seen.add(item);
				}
			}
		}

		const frequentItems = [...itemCounts.entries()]
			.filter(([, count]) => count >= minSupportCount)
			.map(([item]) => item);

		// Recursively mine sequential patterns
		for (const item of frequentItems) {
			this.prefixSpanRecursive(
				[item],
				sequences,
				minSupportCount,
				totalSessions,
				results,
			);
		}

		return results.filter(
			(p) => p.sequence.length >= this.config.minSequenceLength,
		);
	}

	/**
	 * Recursive PrefixSpan mining.
	 */
	private prefixSpanRecursive(
		prefix: string[],
		sequences: Array<{ items: string[]; duration: number }>,
		minSupportCount: number,
		totalSessions: number,
		results: SequentialPattern[],
	): void {
		// Project sequences with the prefix
		const projected = this.projectSequences(prefix, sequences);

		if (projected.length >= minSupportCount) {
			// Calculate average duration
			const avgDuration =
				projected.reduce((sum, s) => sum + s.duration, 0) / projected.length;

			results.push({
				sequence: prefix,
				support: projected.length / totalSessions,
				count: projected.length,
				avgDurationMs: avgDuration,
			});

			// Don't extend beyond max length
			if (prefix.length >= this.config.maxPatternLength) {
				return;
			}

			// Find frequent extensions
			const extensionCounts = new Map<string, number>();
			for (const seq of projected) {
				const seen = new Set<string>();
				for (const item of seq.items) {
					if (!seen.has(item)) {
						extensionCounts.set(item, (extensionCounts.get(item) || 0) + 1);
						seen.add(item);
					}
				}
			}

			// Recurse on frequent extensions
			for (const [item, count] of extensionCounts) {
				if (count >= minSupportCount) {
					this.prefixSpanRecursive(
						[...prefix, item],
						projected,
						minSupportCount,
						totalSessions,
						results,
					);
				}
			}
		}
	}

	/**
	 * Project sequences to those containing the prefix.
	 */
	private projectSequences(
		prefix: string[],
		sequences: Array<{ items: string[]; duration: number }>,
	): Array<{ items: string[]; duration: number }> {
		const projected: Array<{ items: string[]; duration: number }> = [];

		for (const seq of sequences) {
			let matchIndex = -1;

			// Find the last occurrence of prefix in sequence
			for (let i = 0; i <= seq.items.length - prefix.length; i++) {
				let matches = true;
				for (let j = 0; j < prefix.length; j++) {
					if (seq.items[i + j] !== prefix[j]) {
						matches = false;
						break;
					}
				}
				if (matches) {
					matchIndex = i + prefix.length;
				}
			}

			// Add suffix to projected database
			if (matchIndex >= 0 && matchIndex < seq.items.length) {
				projected.push({
					items: seq.items.slice(matchIndex),
					duration: seq.duration,
				});
			}
		}

		return projected;
	}

	// ========================================================================
	// Helper Methods
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
	 * Extract itemsets (tool+outcome) from session events.
	 */
	private extractTransactions(
		sessionEvents: Map<string, ToolEvent[]>,
	): string[][] {
		const transactions: string[][] = [];

		for (const events of sessionEvents.values()) {
			const items = new Set<string>();

			for (const event of events) {
				// Add tool name
				items.add(`tool:${event.toolName}`);

				// Add outcome
				if (event.success) {
					items.add(`outcome:success`);
				} else {
					items.add(`outcome:failure`);
					if (event.errorType) {
						items.add(`error:${event.errorType}`);
					}
				}
			}

			transactions.push([...items]);
		}

		return transactions;
	}

	/**
	 * Extract sequences for sequential pattern mining.
	 */
	private extractSequences(
		sessionEvents: Map<string, ToolEvent[]>,
	): Array<{ items: string[]; duration: number }> {
		const sequences: Array<{ items: string[]; duration: number }> = [];

		for (const events of sessionEvents.values()) {
			if (events.length < 2) continue;

			const items = events.map((e) => e.toolName);
			const duration =
				events.length > 0
					? events[events.length - 1].timestamp - events[0].timestamp
					: 0;

			sequences.push({ items, duration });
		}

		return sequences;
	}

	/**
	 * Generate all subsets of an array.
	 */
	private generateSubsets(items: string[]): string[][] {
		const result: string[][] = [[]];

		for (const item of items) {
			const newSubsets = result.map((subset) => [...subset, item]);
			result.push(...newSubsets);
		}

		return result;
	}

	/**
	 * Identify error patterns from frequent itemsets and rules.
	 */
	private identifyErrorPatterns(
		itemsets: FrequentItemset[],
		rules: AssociationRule[],
		events: ToolEvent[],
	): DetectedPattern[] {
		const patterns: DetectedPattern[] = [];

		// Find itemsets with error markers
		for (const itemset of itemsets) {
			if (itemset.items.some((i) => i.startsWith("error:"))) {
				const errorTypes = itemset.items
					.filter((i) => i.startsWith("error:"))
					.map((i) => i.replace("error:", ""));
				const tools = itemset.items
					.filter((i) => i.startsWith("tool:"))
					.map((i) => i.replace("tool:", ""));

				patterns.push({
					patternId: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
					patternType: "error",
					patternHash: this.hashPattern(itemset.items),
					patternData: {
						description: `Error pattern: ${errorTypes.join(", ")} with ${tools.join(", ")}`,
						tools,
						errorTypes,
						support: itemset.support,
						confidence: 1,
					},
					occurrenceCount: itemset.count,
					lastSeen: Date.now(),
					severity: itemset.support > 0.1 ? "critical" : "medium",
					projectScope: undefined,
				});
			}
		}

		// Find rules that predict errors
		for (const rule of rules) {
			if (rule.consequent.some((i) => i.startsWith("error:"))) {
				const antecedentTools = rule.antecedent
					.filter((i) => i.startsWith("tool:"))
					.map((i) => i.replace("tool:", ""));
				const errorTypes = rule.consequent
					.filter((i) => i.startsWith("error:"))
					.map((i) => i.replace("error:", ""));

				patterns.push({
					patternId: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
					patternType: "error",
					patternHash: this.hashPattern([
						...rule.antecedent,
						...rule.consequent,
					]),
					patternData: {
						description: `${antecedentTools.join(" + ")} → ${errorTypes.join(", ")} (${(rule.confidence * 100).toFixed(0)}% confidence)`,
						tools: antecedentTools,
						errorTypes,
						support: rule.support,
						confidence: rule.confidence,
						lift: rule.lift,
					},
					occurrenceCount: Math.round(rule.support * events.length),
					lastSeen: Date.now(),
					severity: rule.confidence > 0.8 ? "critical" : "medium",
					projectScope: undefined,
				});
			}
		}

		return patterns;
	}

	/**
	 * Identify workflow patterns from sequential patterns.
	 */
	private identifyWorkflowPatterns(
		sequences: SequentialPattern[],
		events: ToolEvent[],
	): DetectedPattern[] {
		const patterns: DetectedPattern[] = [];

		for (const seq of sequences) {
			if (seq.sequence.length >= this.config.minSequenceLength) {
				// Calculate automation potential
				const automationPotential = this.calculateAutomationPotential(seq);

				patterns.push({
					patternId: `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
					patternType: "workflow",
					patternHash: this.hashPattern(seq.sequence),
					patternData: {
						description: seq.sequence.join(" → "),
						sequence: seq.sequence,
						support: seq.support,
						avgDurationMs: seq.avgDurationMs,
						automationPotential,
					},
					occurrenceCount: seq.count,
					lastSeen: Date.now(),
					severity: automationPotential > 0.7 ? "low" : "medium",
					projectScope: undefined,
				});
			}
		}

		return patterns.sort(
			(a, b) =>
				((b.patternData as PatternData).automationPotential ?? 0) -
				((a.patternData as PatternData).automationPotential ?? 0),
		);
	}

	/**
	 * Calculate automation potential for a workflow.
	 */
	private calculateAutomationPotential(seq: SequentialPattern): number {
		// Higher support = more common = better automation candidate
		const supportScore = Math.min(1, seq.support * 5);

		// Longer sequences = more complex = lower automation potential
		const lengthScore = Math.max(0, 1 - (seq.sequence.length - 2) * 0.1);

		// Consistent timing = more predictable = better automation
		const timingScore = seq.avgDurationMs < 10000 ? 1 : 0.5;

		// Check if sequence contains Read/Edit patterns (good for automation)
		const hasFileOps =
			seq.sequence.includes("Read") || seq.sequence.includes("Edit");
		const fileScore = hasFileOps ? 1.2 : 1;

		return Math.min(
			1,
			((supportScore + lengthScore + timingScore) * fileScore) / 3,
		);
	}

	/**
	 * Create a hash for pattern deduplication.
	 */
	private hashPattern(items: string[]): string {
		const sorted = [...items].sort();
		return sorted.join("|");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a pattern miner with optional configuration.
 */
export function createPatternMiner(
	config: Partial<PatternMinerConfig> = {},
): PatternMiner {
	return new PatternMiner(config);
}
