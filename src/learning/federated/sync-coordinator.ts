/**
 * SyncCoordinator - Coordinate opt-in pattern sharing across projects.
 *
 * Provides federated learning capabilities:
 * - Local model training
 * - Anonymized pattern sharing
 * - Pattern aggregation from peers
 * - Conflict resolution
 */

import type { DetectedPattern } from "../interaction/types.js";
import type { HashedPattern, PatternHasher } from "./pattern-hasher.js";

// ============================================================================
// Types
// ============================================================================

export interface SyncCoordinatorConfig {
	/** Enable federated sync */
	enabled: boolean;
	/** Sync interval in ms */
	syncIntervalMs: number;
	/** Maximum patterns to share per sync */
	maxPatternsPerSync: number;
	/** Minimum local patterns before sharing */
	minLocalPatterns: number;
	/** Trust score threshold for accepting patterns */
	trustThreshold: number;
	/** Pattern weight from local vs remote */
	localWeight: number;
	/** Maximum age of patterns to accept (ms) */
	maxPatternAgeMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncCoordinatorConfig = {
	enabled: false, // Opt-in
	syncIntervalMs: 24 * 60 * 60 * 1000, // Daily
	maxPatternsPerSync: 100,
	minLocalPatterns: 10,
	trustThreshold: 0.7,
	localWeight: 0.8,
	maxPatternAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export interface SyncPeer {
	/** Peer ID (hashed) */
	peerId: string;
	/** Peer name (optional) */
	name?: string;
	/** Last sync timestamp */
	lastSync: number;
	/** Trust score (0-1) */
	trustScore: number;
	/** Patterns received from this peer */
	patternsReceived: number;
	/** Patterns that proved useful */
	patternsUseful: number;
}

export interface SyncPacket {
	/** Packet ID */
	packetId: string;
	/** Sender peer ID */
	senderId: string;
	/** Timestamp */
	timestamp: number;
	/** Hashed patterns */
	patterns: HashedPattern[];
	/** Metadata */
	metadata: SyncMetadata;
}

export interface SyncMetadata {
	/** Protocol version */
	version: string;
	/** Total patterns at sender */
	totalPatterns: number;
	/** Sender's local model hash (for compatibility) */
	modelHash: string;
	/** Categories of patterns included */
	categories: string[];
}

export interface SyncResult {
	/** Whether sync succeeded */
	success: boolean;
	/** Patterns sent */
	patternsSent: number;
	/** Patterns received */
	patternsReceived: number;
	/** New patterns integrated */
	patternsIntegrated: number;
	/** Patterns rejected */
	patternsRejected: number;
	/** Timestamp */
	timestamp: number;
	/** Error message if failed */
	error?: string;
}

export interface MergedPattern {
	/** Merged pattern hash */
	structuralHash: string;
	/** Combined count (weighted) */
	combinedCount: number;
	/** Sources (peer IDs) */
	sources: string[];
	/** Confidence in merge */
	mergeConfidence: number;
	/** Original pattern type */
	patternType: string;
	/** Aggregated data */
	aggregatedData: AggregatedPatternData;
}

export interface AggregatedPatternData {
	/** Tool sequence (if workflow) */
	toolSequence?: string[];
	/** Error category (if error) */
	errorCategory?: string;
	/** Average confidence across sources */
	avgConfidence: number;
	/** Total observations across sources */
	totalObservations: number;
	/** Success rate bucket */
	successRateBucket?: string;
}

// ============================================================================
// SyncCoordinator Class
// ============================================================================

export class SyncCoordinator {
	private config: SyncCoordinatorConfig;
	private hasher: PatternHasher;
	private peers: Map<string, SyncPeer>;
	private receivedPatterns: Map<string, HashedPattern[]>; // structuralHash -> patterns
	private mergedPatterns: Map<string, MergedPattern>;
	private syncHistory: SyncResult[];
	private localPeerId: string;

	constructor(
		hasher: PatternHasher,
		config: Partial<SyncCoordinatorConfig> = {}
	) {
		this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
		this.hasher = hasher;
		this.peers = new Map();
		this.receivedPatterns = new Map();
		this.mergedPatterns = new Map();
		this.syncHistory = [];
		this.localPeerId = this.generatePeerId();
	}

	/**
	 * Enable federated sync.
	 */
	enable(): void {
		this.config.enabled = true;
	}

	/**
	 * Disable federated sync.
	 */
	disable(): void {
		this.config.enabled = false;
	}

	/**
	 * Check if sync is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Prepare patterns for sharing.
	 */
	prepareForSync(patterns: DetectedPattern[]): SyncPacket | null {
		if (!this.config.enabled) {
			return null;
		}

		if (patterns.length < this.config.minLocalPatterns) {
			return null; // Not enough patterns to share
		}

		// Hash patterns
		const hashResult = this.hasher.hashPatterns(patterns);

		// Select top patterns for sharing
		const toShare = hashResult.hashed
			.filter((p) => p.isShareable)
			.slice(0, this.config.maxPatternsPerSync);

		if (toShare.length === 0) {
			return null;
		}

		return {
			packetId: `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
			senderId: this.localPeerId,
			timestamp: Date.now(),
			patterns: toShare,
			metadata: {
				version: "1.0",
				totalPatterns: patterns.length,
				modelHash: this.computeModelHash(patterns),
				categories: [...new Set(toShare.map((p) => p.patternType))],
			},
		};
	}

	/**
	 * Receive patterns from a peer.
	 */
	receivePatterns(packet: SyncPacket): SyncResult {
		if (!this.config.enabled) {
			return {
				success: false,
				patternsSent: 0,
				patternsReceived: 0,
				patternsIntegrated: 0,
				patternsRejected: 0,
				timestamp: Date.now(),
				error: "Sync is disabled",
			};
		}

		// Validate packet
		if (!this.validatePacket(packet)) {
			return {
				success: false,
				patternsSent: 0,
				patternsReceived: packet.patterns.length,
				patternsIntegrated: 0,
				patternsRejected: packet.patterns.length,
				timestamp: Date.now(),
				error: "Invalid packet",
			};
		}

		// Get or create peer
		const peer = this.getOrCreatePeer(packet.senderId);

		// Check trust
		if (peer.trustScore < this.config.trustThreshold) {
			return {
				success: false,
				patternsSent: 0,
				patternsReceived: packet.patterns.length,
				patternsIntegrated: 0,
				patternsRejected: packet.patterns.length,
				timestamp: Date.now(),
				error: `Peer trust ${peer.trustScore} below threshold ${this.config.trustThreshold}`,
			};
		}

		// Process patterns
		let integrated = 0;
		let rejected = 0;

		for (const pattern of packet.patterns) {
			if (this.integratePattern(pattern, packet.senderId)) {
				integrated++;
			} else {
				rejected++;
			}
		}

		// Update peer stats
		peer.patternsReceived += packet.patterns.length;
		peer.lastSync = Date.now();

		const result: SyncResult = {
			success: true,
			patternsSent: 0,
			patternsReceived: packet.patterns.length,
			patternsIntegrated: integrated,
			patternsRejected: rejected,
			timestamp: Date.now(),
		};

		this.syncHistory.push(result);

		return result;
	}

	/**
	 * Get merged patterns for local use.
	 */
	getMergedPatterns(): MergedPattern[] {
		return Array.from(this.mergedPatterns.values());
	}

	/**
	 * Mark a pattern as useful (for trust adjustment).
	 */
	markPatternUseful(structuralHash: string): void {
		const merged = this.mergedPatterns.get(structuralHash);
		if (!merged) return;

		// Increase trust for contributing peers
		for (const peerId of merged.sources) {
			const peer = this.peers.get(peerId);
			if (peer) {
				peer.patternsUseful++;
				// Adjust trust based on useful ratio
				if (peer.patternsReceived > 0) {
					peer.trustScore = Math.min(
						1,
						peer.trustScore * 0.9 + (peer.patternsUseful / peer.patternsReceived) * 0.1
					);
				}
			}
		}
	}

	/**
	 * Get peer list.
	 */
	getPeers(): SyncPeer[] {
		return Array.from(this.peers.values());
	}

	/**
	 * Get sync history.
	 */
	getSyncHistory(limit: number = 10): SyncResult[] {
		return this.syncHistory.slice(-limit);
	}

	/**
	 * Get statistics.
	 */
	getStatistics(): {
		enabled: boolean;
		peerCount: number;
		mergedPatternCount: number;
		totalReceived: number;
		totalIntegrated: number;
		avgTrustScore: number;
	} {
		const peers = Array.from(this.peers.values());
		const totalReceived = peers.reduce((sum, p) => sum + p.patternsReceived, 0);
		const totalIntegrated = this.syncHistory.reduce(
			(sum, r) => sum + r.patternsIntegrated,
			0
		);
		const avgTrustScore =
			peers.length > 0
				? peers.reduce((sum, p) => sum + p.trustScore, 0) / peers.length
				: 0;

		return {
			enabled: this.config.enabled,
			peerCount: this.peers.size,
			mergedPatternCount: this.mergedPatterns.size,
			totalReceived,
			totalIntegrated,
			avgTrustScore,
		};
	}

	/**
	 * Export state.
	 */
	export(): {
		peers: Array<SyncPeer>;
		mergedPatterns: Array<[string, MergedPattern]>;
		syncHistory: SyncResult[];
		localPeerId: string;
	} {
		return {
			peers: Array.from(this.peers.values()),
			mergedPatterns: Array.from(this.mergedPatterns.entries()),
			syncHistory: this.syncHistory,
			localPeerId: this.localPeerId,
		};
	}

	/**
	 * Import state.
	 */
	import(data: {
		peers: Array<SyncPeer>;
		mergedPatterns: Array<[string, MergedPattern]>;
		syncHistory: SyncResult[];
		localPeerId: string;
	}): void {
		this.peers = new Map(data.peers.map((p) => [p.peerId, p]));
		this.mergedPatterns = new Map(data.mergedPatterns);
		this.syncHistory = data.syncHistory;
		this.localPeerId = data.localPeerId;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Generate local peer ID.
	 */
	private generatePeerId(): string {
		return `peer_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`;
	}

	/**
	 * Compute model hash.
	 */
	private computeModelHash(patterns: DetectedPattern[]): string {
		// Simple hash of pattern types and counts
		const summary = patterns
			.map((p) => `${p.patternType}:${p.occurrenceCount}`)
			.sort()
			.join("|");

		// Use first 16 chars of hash
		let hash = 0;
		for (let i = 0; i < summary.length; i++) {
			const char = summary.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(16).padStart(16, "0");
	}

	/**
	 * Validate sync packet.
	 */
	private validatePacket(packet: SyncPacket): boolean {
		// Check required fields
		if (!packet.packetId || !packet.senderId || !packet.timestamp) {
			return false;
		}

		// Check age
		const age = Date.now() - packet.timestamp;
		if (age > this.config.maxPatternAgeMs) {
			return false;
		}

		// Check patterns
		if (!packet.patterns || packet.patterns.length === 0) {
			return false;
		}

		// Check metadata
		if (!packet.metadata || !packet.metadata.version) {
			return false;
		}

		return true;
	}

	/**
	 * Get or create peer.
	 */
	private getOrCreatePeer(peerId: string): SyncPeer {
		let peer = this.peers.get(peerId);
		if (!peer) {
			peer = {
				peerId,
				lastSync: 0,
				trustScore: 0.5, // Initial neutral trust
				patternsReceived: 0,
				patternsUseful: 0,
			};
			this.peers.set(peerId, peer);
		}
		return peer;
	}

	/**
	 * Integrate a received pattern.
	 */
	private integratePattern(pattern: HashedPattern, peerId: string): boolean {
		if (!pattern.isShareable) {
			return false;
		}

		// Store in received patterns
		const existing = this.receivedPatterns.get(pattern.structuralHash) || [];
		existing.push(pattern);
		this.receivedPatterns.set(pattern.structuralHash, existing);

		// Merge with existing patterns
		this.mergePattern(pattern, peerId);

		return true;
	}

	/**
	 * Merge pattern into aggregated view.
	 */
	private mergePattern(pattern: HashedPattern, peerId: string): void {
		let merged = this.mergedPatterns.get(pattern.structuralHash);

		if (!merged) {
			// Create new merged pattern
			merged = {
				structuralHash: pattern.structuralHash,
				combinedCount: pattern.noisyCount,
				sources: [peerId],
				mergeConfidence: pattern.anonymizedData.noisyConfidence,
				patternType: pattern.patternType,
				aggregatedData: {
					toolSequence: pattern.anonymizedData.toolSequence,
					errorCategory: pattern.anonymizedData.errorCategory,
					avgConfidence: pattern.anonymizedData.noisyConfidence,
					totalObservations: pattern.noisyCount,
					successRateBucket: pattern.anonymizedData.successRateBucket,
				},
			};
		} else {
			// Merge with existing
			if (!merged.sources.includes(peerId)) {
				merged.sources.push(peerId);
			}

			// Weighted average of counts
			const localWeight = this.config.localWeight;
			const remoteWeight = 1 - localWeight;

			merged.combinedCount =
				merged.combinedCount * localWeight + pattern.noisyCount * remoteWeight;

			// Update confidence
			merged.aggregatedData.avgConfidence =
				(merged.aggregatedData.avgConfidence + pattern.anonymizedData.noisyConfidence) / 2;

			// Update total observations
			merged.aggregatedData.totalObservations += pattern.noisyCount;

			// Increase merge confidence with more sources
			merged.mergeConfidence = Math.min(
				1,
				merged.mergeConfidence + 0.1 * (1 - merged.mergeConfidence)
			);
		}

		this.mergedPatterns.set(pattern.structuralHash, merged);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a sync coordinator with hasher and optional configuration.
 */
export function createSyncCoordinator(
	hasher: PatternHasher,
	config: Partial<SyncCoordinatorConfig> = {}
): SyncCoordinator {
	return new SyncCoordinator(hasher, config);
}
