/**
 * ErrorClusterer - Groups similar errors for pattern detection.
 *
 * Uses a combination of:
 * - Error type categorization
 * - Message similarity (Jaccard/cosine)
 * - Tool context clustering
 *
 * Clustered errors help identify:
 * - Repetitive agent mistakes
 * - Common failure modes
 * - Areas needing improvement
 */

import type { ToolEvent } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface ErrorClusterConfig {
	/** Minimum similarity for clustering (0-1) */
	minSimilarity: number;
	/** Maximum number of clusters */
	maxClusters: number;
	/** Minimum errors per cluster */
	minClusterSize: number;
}

export const DEFAULT_CLUSTER_CONFIG: ErrorClusterConfig = {
	minSimilarity: 0.5,
	maxClusters: 50,
	minClusterSize: 2,
};

export interface ErrorInstance {
	toolUseId: string;
	sessionId: string;
	toolName: string;
	errorType?: string;
	errorMessage?: string;
	timestamp: number;
}

export interface ErrorCluster {
	clusterId: string;
	/** Representative error for the cluster */
	centroid: ErrorInstance;
	/** All errors in this cluster */
	members: ErrorInstance[];
	/** Dominant error type in cluster */
	errorType: string;
	/** Common tools involved */
	tools: string[];
	/** Cluster quality score (0-1) */
	cohesion: number;
	/** How often this error occurs */
	frequency: number;
	/** Suggested fix category */
	suggestedCategory:
		| "validation"
		| "logic"
		| "permission"
		| "timeout"
		| "unknown";
}

export interface ClusteringResult {
	clusters: ErrorCluster[];
	noise: ErrorInstance[];
	totalErrors: number;
	clusteringQuality: number;
}

// ============================================================================
// ErrorClusterer Class
// ============================================================================

export class ErrorClusterer {
	private config: ErrorClusterConfig;

	constructor(config: Partial<ErrorClusterConfig> = {}) {
		this.config = { ...DEFAULT_CLUSTER_CONFIG, ...config };
	}

	/**
	 * Cluster error events from tool executions.
	 */
	cluster(events: ToolEvent[]): ClusteringResult {
		// Extract failed events
		const errorInstances = this.extractErrors(events);

		if (errorInstances.length === 0) {
			return {
				clusters: [],
				noise: [],
				totalErrors: 0,
				clusteringQuality: 1,
			};
		}

		// Simple hierarchical clustering
		const clusters = this.hierarchicalClustering(errorInstances);

		// Calculate noise (unclustered errors)
		const clusteredIds = new Set(
			clusters.flatMap((c) => c.members.map((m) => m.toolUseId)),
		);
		const noise = errorInstances.filter((e) => !clusteredIds.has(e.toolUseId));

		// Calculate clustering quality
		const clusteringQuality = this.calculateQuality(
			clusters,
			errorInstances.length,
		);

		return {
			clusters,
			noise,
			totalErrors: errorInstances.length,
			clusteringQuality,
		};
	}

	/**
	 * Get top error clusters by frequency.
	 */
	getTopClusters(result: ClusteringResult, limit = 10): ErrorCluster[] {
		return result.clusters
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, limit);
	}

	/**
	 * Get clusters by error type.
	 */
	getClustersByType(
		result: ClusteringResult,
		errorType: string,
	): ErrorCluster[] {
		return result.clusters.filter((c) => c.errorType === errorType);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Extract error instances from tool events.
	 */
	private extractErrors(events: ToolEvent[]): ErrorInstance[] {
		return events
			.filter((e) => !e.success)
			.map((e) => ({
				toolUseId: e.toolUseId,
				sessionId: e.sessionId,
				toolName: e.toolName,
				errorType: e.errorType,
				errorMessage: e.error,
				timestamp: e.timestamp,
			}));
	}

	/**
	 * Hierarchical agglomerative clustering.
	 */
	private hierarchicalClustering(errors: ErrorInstance[]): ErrorCluster[] {
		// Initialize each error as its own cluster
		let clusters: ErrorInstance[][] = errors.map((e) => [e]);

		// Merge until we reach max clusters or no more similar pairs
		while (clusters.length > this.config.maxClusters) {
			const { i, j, similarity } = this.findMostSimilarPair(clusters);

			if (similarity < this.config.minSimilarity) {
				break;
			}

			// Merge clusters i and j
			const merged = [...clusters[i], ...clusters[j]];
			clusters = clusters.filter((_, idx) => idx !== i && idx !== j);
			clusters.push(merged);
		}

		// Filter small clusters and convert to ErrorCluster format
		return clusters
			.filter((c) => c.length >= this.config.minClusterSize)
			.map((members) => this.createCluster(members, errors.length));
	}

	/**
	 * Find the most similar pair of clusters.
	 */
	private findMostSimilarPair(clusters: ErrorInstance[][]): {
		i: number;
		j: number;
		similarity: number;
	} {
		let maxSimilarity = -1;
		let bestI = 0;
		let bestJ = 1;

		for (let i = 0; i < clusters.length; i++) {
			for (let j = i + 1; j < clusters.length; j++) {
				const similarity = this.clusterSimilarity(clusters[i], clusters[j]);
				if (similarity > maxSimilarity) {
					maxSimilarity = similarity;
					bestI = i;
					bestJ = j;
				}
			}
		}

		return { i: bestI, j: bestJ, similarity: maxSimilarity };
	}

	/**
	 * Calculate similarity between two clusters (average linkage).
	 */
	private clusterSimilarity(
		cluster1: ErrorInstance[],
		cluster2: ErrorInstance[],
	): number {
		let totalSimilarity = 0;
		let count = 0;

		for (const e1 of cluster1) {
			for (const e2 of cluster2) {
				totalSimilarity += this.errorSimilarity(e1, e2);
				count++;
			}
		}

		return count > 0 ? totalSimilarity / count : 0;
	}

	/**
	 * Calculate similarity between two error instances.
	 */
	private errorSimilarity(e1: ErrorInstance, e2: ErrorInstance): number {
		let score = 0;
		let weights = 0;

		// Same tool = high similarity
		if (e1.toolName === e2.toolName) {
			score += 0.4;
		}
		weights += 0.4;

		// Same error type = high similarity
		if (e1.errorType && e2.errorType && e1.errorType === e2.errorType) {
			score += 0.3;
		}
		weights += 0.3;

		// Error message similarity
		if (e1.errorMessage && e2.errorMessage) {
			const messageSim = this.stringSimilarity(
				e1.errorMessage,
				e2.errorMessage,
			);
			score += messageSim * 0.3;
		}
		weights += 0.3;

		return weights > 0 ? score / weights : 0;
	}

	/**
	 * Calculate string similarity using Jaccard index on tokens.
	 */
	private stringSimilarity(s1: string, s2: string): number {
		const tokens1 = this.tokenize(s1);
		const tokens2 = this.tokenize(s2);

		if (tokens1.size === 0 || tokens2.size === 0) {
			return 0;
		}

		let intersection = 0;
		for (const token of tokens1) {
			if (tokens2.has(token)) {
				intersection++;
			}
		}

		const union = tokens1.size + tokens2.size - intersection;
		return intersection / union;
	}

	/**
	 * Tokenize a string for similarity comparison.
	 */
	private tokenize(text: string): Set<string> {
		return new Set(
			text
				.toLowerCase()
				.replace(/[^\w\s]/g, " ")
				.split(/\s+/)
				.filter((t) => t.length > 2),
		);
	}

	/**
	 * Create an ErrorCluster from member instances.
	 */
	private createCluster(
		members: ErrorInstance[],
		totalErrors: number,
	): ErrorCluster {
		// Find most common error type
		const typeCounts = new Map<string, number>();
		for (const m of members) {
			const type = m.errorType || "unknown";
			typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
		}
		const errorType =
			[...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
			"unknown";

		// Find all tools involved
		const tools = [...new Set(members.map((m) => m.toolName))];

		// Pick centroid (most representative error)
		const centroid = this.findCentroid(members);

		// Calculate cohesion (average similarity within cluster)
		const cohesion = this.calculateCohesion(members);

		return {
			clusterId: `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
			centroid,
			members,
			errorType,
			tools,
			cohesion,
			frequency: members.length / totalErrors,
			suggestedCategory: this.categorizeError(errorType, members),
		};
	}

	/**
	 * Find the centroid (most central error) in a cluster.
	 */
	private findCentroid(members: ErrorInstance[]): ErrorInstance {
		let bestError = members[0];
		let bestAvgSim = 0;

		for (const candidate of members) {
			let totalSim = 0;
			for (const other of members) {
				if (candidate !== other) {
					totalSim += this.errorSimilarity(candidate, other);
				}
			}
			const avgSim = totalSim / (members.length - 1);
			if (avgSim > bestAvgSim) {
				bestAvgSim = avgSim;
				bestError = candidate;
			}
		}

		return bestError;
	}

	/**
	 * Calculate cluster cohesion (internal similarity).
	 */
	private calculateCohesion(members: ErrorInstance[]): number {
		if (members.length < 2) return 1;

		let totalSim = 0;
		let count = 0;

		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				totalSim += this.errorSimilarity(members[i], members[j]);
				count++;
			}
		}

		return count > 0 ? totalSim / count : 0;
	}

	/**
	 * Calculate overall clustering quality.
	 */
	private calculateQuality(
		clusters: ErrorCluster[],
		totalErrors: number,
	): number {
		if (clusters.length === 0) return 1;

		// Average cohesion weighted by cluster size
		let weightedCohesion = 0;
		let totalWeight = 0;

		for (const cluster of clusters) {
			weightedCohesion += cluster.cohesion * cluster.members.length;
			totalWeight += cluster.members.length;
		}

		return totalWeight > 0 ? weightedCohesion / totalWeight : 0;
	}

	/**
	 * Categorize error for suggested fix.
	 */
	private categorizeError(
		errorType: string,
		members: ErrorInstance[],
	): "validation" | "logic" | "permission" | "timeout" | "unknown" {
		// Check error type
		if (errorType === "validation") return "validation";
		if (errorType === "permission") return "permission";
		if (errorType === "timeout") return "timeout";
		if (errorType === "logic") return "logic";

		// Check error messages for patterns
		const messages = members
			.map((m) => m.errorMessage?.toLowerCase() || "")
			.join(" ");

		if (
			messages.includes("permission") ||
			messages.includes("denied") ||
			messages.includes("access")
		) {
			return "permission";
		}
		if (messages.includes("timeout") || messages.includes("timed out")) {
			return "timeout";
		}
		if (
			messages.includes("invalid") ||
			messages.includes("validation") ||
			messages.includes("required")
		) {
			return "validation";
		}
		if (
			messages.includes("error") ||
			messages.includes("failed") ||
			messages.includes("exception")
		) {
			return "logic";
		}

		return "unknown";
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an error clusterer with optional configuration.
 */
export function createErrorClusterer(
	config: Partial<ErrorClusterConfig> = {},
): ErrorClusterer {
	return new ErrorClusterer(config);
}
