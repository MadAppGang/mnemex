/**
 * PatternHasher - Anonymize patterns for federated sharing.
 *
 * Ensures privacy-preserving pattern sharing:
 * - Hash sensitive details (file paths, content)
 * - Preserve structural patterns (tool sequences, error types)
 * - Add differential privacy noise
 * - Enable pattern matching without revealing specifics
 */

import { createHash, randomBytes } from "crypto";
import type { DetectedPattern, PatternData } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface PatternHasherConfig {
	/** Hash algorithm to use */
	hashAlgorithm: "sha256" | "sha512" | "blake2b";
	/** Salt for additional privacy */
	salt: string;
	/** Enable differential privacy */
	enableDifferentialPrivacy: boolean;
	/** Epsilon for differential privacy (smaller = more private) */
	epsilon: number;
	/** Minimum count to share (k-anonymity) */
	minCount: number;
	/** Fields to always redact */
	redactFields: string[];
}

/** Minimum salt length for security */
const MIN_SALT_LENGTH = 8;

export const DEFAULT_HASHER_CONFIG: PatternHasherConfig = {
	hashAlgorithm: "sha256",
	salt: randomBytes(16).toString("hex"), // Random per-instance default
	enableDifferentialPrivacy: true,
	epsilon: 1.0,
	minCount: 5, // k=5 anonymity
	redactFields: ["filePath", "content", "sessionId", "userId", "apiKey"],
};

export interface HashedPattern {
	/** Hashed pattern ID */
	hashedId: string;
	/** Pattern type (preserved) */
	patternType: string;
	/** Structural hash (for matching) */
	structuralHash: string;
	/** Anonymized pattern data */
	anonymizedData: AnonymizedPatternData;
	/** Noisy occurrence count */
	noisyCount: number;
	/** Timestamp bucket (day granularity) */
	timestampBucket: number;
	/** Whether this pattern is shareable */
	isShareable: boolean;
	/** Reason if not shareable */
	nonShareableReason?: string;
}

export interface AnonymizedPatternData {
	/** Pattern category (workflow, error, etc.) */
	category: string;
	/** Tool sequence (preserved) */
	toolSequence?: string[];
	/** Error type category (not specific message) */
	errorCategory?: string;
	/** Confidence (with noise) */
	noisyConfidence: number;
	/** Duration bucket */
	durationBucket?: string;
	/** Success rate bucket */
	successRateBucket?: string;
	/** Generic metadata */
	metadata: Record<string, string | number>;
}

export interface HashingResult {
	hashed: HashedPattern[];
	skipped: Array<{
		patternId: string;
		reason: string;
	}>;
	privacyReport: PrivacyReport;
}

export interface PrivacyReport {
	/** Total patterns processed */
	totalProcessed: number;
	/** Patterns that met k-anonymity */
	metKAnonymity: number;
	/** Fields redacted */
	fieldsRedacted: number;
	/** Noise added (sum of absolute noise) */
	noiseAdded: number;
	/** Estimated privacy budget used */
	privacyBudgetUsed: number;
}

// ============================================================================
// PatternHasher Class
// ============================================================================

export class PatternHasher {
	private config: PatternHasherConfig;
	private privacyBudgetUsed: number;

	constructor(config: Partial<PatternHasherConfig> = {}) {
		this.config = { ...DEFAULT_HASHER_CONFIG, ...config };
		this.privacyBudgetUsed = 0;

		// Validate salt for security
		if (!this.config.salt || this.config.salt.length < MIN_SALT_LENGTH) {
			throw new Error(
				`PatternHasher requires a salt of at least ${MIN_SALT_LENGTH} characters for security`,
			);
		}
	}

	/**
	 * Hash a single pattern for sharing.
	 */
	hashPattern(pattern: DetectedPattern): HashedPattern {
		// Check k-anonymity
		const isShareable = pattern.occurrenceCount >= this.config.minCount;
		const nonShareableReason = isShareable
			? undefined
			: `Count ${pattern.occurrenceCount} below k=${this.config.minCount}`;

		// Hash the pattern ID
		const hashedId = this.hash(pattern.patternId);

		// Create structural hash (for matching similar patterns)
		const structuralHash = this.createStructuralHash(pattern);

		// Anonymize pattern data
		const anonymizedData = this.anonymizePatternData(pattern.patternData);

		// Add noise to count
		const noisyCount = this.addLaplaceNoise(
			pattern.occurrenceCount,
			this.config.epsilon
		);

		// Bucket timestamp to day
		const timestampBucket = this.bucketTimestamp(pattern.lastSeen);

		return {
			hashedId,
			patternType: pattern.patternType,
			structuralHash,
			anonymizedData,
			noisyCount: Math.max(0, Math.round(noisyCount)),
			timestampBucket,
			isShareable,
			nonShareableReason,
		};
	}

	/**
	 * Hash multiple patterns.
	 */
	hashPatterns(patterns: DetectedPattern[]): HashingResult {
		const hashed: HashedPattern[] = [];
		const skipped: Array<{ patternId: string; reason: string }> = [];
		let fieldsRedacted = 0;
		let noiseAdded = 0;

		for (const pattern of patterns) {
			const result = this.hashPattern(pattern);

			if (result.isShareable) {
				hashed.push(result);
				noiseAdded += Math.abs(result.noisyCount - pattern.occurrenceCount);
			} else {
				skipped.push({
					patternId: pattern.patternId,
					reason: result.nonShareableReason ?? "Unknown",
				});
			}

			// Count redacted fields
			fieldsRedacted += this.countRedactedFields(pattern.patternData);
		}

		return {
			hashed,
			skipped,
			privacyReport: {
				totalProcessed: patterns.length,
				metKAnonymity: hashed.length,
				fieldsRedacted,
				noiseAdded,
				privacyBudgetUsed: this.privacyBudgetUsed,
			},
		};
	}

	/**
	 * Check if two structural hashes match.
	 */
	matchStructuralHash(hash1: string, hash2: string): boolean {
		return hash1 === hash2;
	}

	/**
	 * Create a fingerprint for pattern matching.
	 */
	createFingerprint(pattern: DetectedPattern): string {
		const components = [
			pattern.patternType,
			...(pattern.patternData.toolSequence ?? []),
			pattern.patternData.errorSignature?.split(":")[0] ?? "",
		];

		return this.hash(components.join("|"));
	}

	/**
	 * Reset privacy budget.
	 */
	resetPrivacyBudget(): void {
		this.privacyBudgetUsed = 0;
	}

	/**
	 * Get remaining privacy budget.
	 */
	getRemainingBudget(totalBudget: number = 10): number {
		return Math.max(0, totalBudget - this.privacyBudgetUsed);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Hash a string.
	 */
	private hash(input: string): string {
		const saltedInput = this.config.salt + input;
		return createHash(this.config.hashAlgorithm)
			.update(saltedInput)
			.digest("hex")
			.substring(0, 32); // Truncate for readability
	}

	/**
	 * Create structural hash for pattern matching.
	 */
	private createStructuralHash(pattern: DetectedPattern): string {
		const structural: string[] = [pattern.patternType];

		// Tool sequence structure
		if (pattern.patternData.toolSequence) {
			structural.push(`tools:${pattern.patternData.toolSequence.join(",")}`);
		} else if (pattern.patternData.sequence) {
			structural.push(`seq:${pattern.patternData.sequence.join(",")}`);
		}

		// Error category (not specific message)
		if (pattern.patternData.errorSignature) {
			const category = this.categorizeError(pattern.patternData.errorSignature);
			structural.push(`error:${category}`);
		}

		// Tools involved
		if (pattern.patternData.tools && pattern.patternData.tools.length > 0) {
			structural.push(`involved:${pattern.patternData.tools.sort().join(",")}`);
		}

		return this.hash(structural.join("|"));
	}

	/**
	 * Anonymize pattern data.
	 */
	private anonymizePatternData(data: PatternData): AnonymizedPatternData {
		const anonymized: AnonymizedPatternData = {
			category: this.categorizePattern(data),
			noisyConfidence: this.addLaplaceNoise(
				data.confidence ?? 0.8,
				this.config.epsilon * 2
			),
			metadata: {},
		};

		// Preserve tool sequence (public info)
		if (data.toolSequence) {
			anonymized.toolSequence = data.toolSequence;
		} else if (data.sequence) {
			anonymized.toolSequence = data.sequence;
		}

		// Categorize error (not specific message)
		if (data.errorSignature) {
			anonymized.errorCategory = this.categorizeError(data.errorSignature);
		}

		// Bucket duration
		if (data.avgDurationMs !== undefined) {
			anonymized.durationBucket = this.bucketDuration(data.avgDurationMs);
		}

		// Bucket success rate
		if (data.successRate !== undefined) {
			anonymized.successRateBucket = this.bucketSuccessRate(data.successRate);
		}

		// Add safe metadata
		if (data.automationPotential !== undefined) {
			anonymized.metadata["automationBucket"] = this.bucketPercent(
				data.automationPotential
			);
		}

		return anonymized;
	}

	/**
	 * Categorize pattern for anonymization.
	 */
	private categorizePattern(data: PatternData): string {
		if (data.toolSequence || data.sequence) {
			return "workflow";
		}
		if (data.errorSignature) {
			return "error";
		}
		return "other";
	}

	/**
	 * Categorize error without revealing specifics.
	 */
	private categorizeError(errorSignature: string): string {
		const lower = errorSignature.toLowerCase();

		if (lower.includes("timeout")) return "timeout";
		if (lower.includes("permission") || lower.includes("denied"))
			return "permission";
		if (lower.includes("not found") || lower.includes("missing"))
			return "not_found";
		if (lower.includes("validation") || lower.includes("invalid"))
			return "validation";
		if (lower.includes("syntax") || lower.includes("parse")) return "syntax";
		if (lower.includes("type")) return "type_error";
		if (lower.includes("network") || lower.includes("connection"))
			return "network";

		return "other";
	}

	/**
	 * Bucket timestamp to day.
	 */
	private bucketTimestamp(timestamp: number): number {
		const day = 24 * 60 * 60 * 1000;
		return Math.floor(timestamp / day) * day;
	}

	/**
	 * Bucket duration.
	 */
	private bucketDuration(durationMs: number): string {
		if (durationMs < 1000) return "<1s";
		if (durationMs < 5000) return "1-5s";
		if (durationMs < 30000) return "5-30s";
		if (durationMs < 60000) return "30s-1m";
		if (durationMs < 300000) return "1-5m";
		return ">5m";
	}

	/**
	 * Bucket success rate.
	 */
	private bucketSuccessRate(rate: number): string {
		if (rate >= 0.9) return "high";
		if (rate >= 0.7) return "medium";
		if (rate >= 0.5) return "low";
		return "very_low";
	}

	/**
	 * Bucket percentage.
	 */
	private bucketPercent(value: number): string {
		if (value >= 0.8) return "high";
		if (value >= 0.5) return "medium";
		return "low";
	}

	/**
	 * Add Laplace noise for differential privacy.
	 */
	private addLaplaceNoise(value: number, epsilon: number): number {
		if (!this.config.enableDifferentialPrivacy || epsilon <= 0) {
			return value;
		}

		// Track privacy budget
		this.privacyBudgetUsed += epsilon;

		// Laplace distribution: b = sensitivity / epsilon
		const sensitivity = 1; // For counts
		const b = sensitivity / epsilon;

		// Sample from Laplace(0, b)
		const u = Math.random() - 0.5;
		const noise = -b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));

		return value + noise;
	}

	/**
	 * Count redacted fields.
	 */
	private countRedactedFields(data: PatternData): number {
		let count = 0;
		const allData = JSON.stringify(data).toLowerCase();

		for (const field of this.config.redactFields) {
			if (allData.includes(field.toLowerCase())) {
				count++;
			}
		}

		return count;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a pattern hasher with optional configuration.
 */
export function createPatternHasher(
	config: Partial<PatternHasherConfig> = {}
): PatternHasher {
	return new PatternHasher(config);
}
