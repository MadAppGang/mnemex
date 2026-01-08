/**
 * CodeChangeTracker - Tracks code changes for "Correction Gap" analysis.
 *
 * The "Correction Gap" is the difference between agent-written code
 * and the user's final modifications. This is one of the strongest
 * implicit feedback signals - when users modify agent code, they're
 * correcting the agent's mistakes or improving its output.
 *
 * This module:
 * - Tracks agent edits with file path, line range, timestamp
 * - Detects when user edits overlap with recent agent edits
 * - Calculates correction metrics (adoption rate, modification rate)
 */

import type { InteractionStore } from "../interaction/interaction-store.js";
import type { CodeChange, CorrectionType } from "../interaction/types.js";
import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface TrackedEdit {
	/** Session that made the edit */
	sessionId: string;
	/** File path (relative to project root) */
	filePath: string;
	/** Whether this was an agent or user edit */
	author: "agent" | "user";
	/** Content hash for comparison */
	contentHash: string;
	/** Line range of the edit */
	startLine?: number;
	endLine?: number;
	/** Lines added/removed */
	linesAdded: number;
	linesRemoved: number;
	/** Timestamp of the edit */
	timestamp: number;
	/** Tool that made the edit (for agent edits) */
	toolName?: string;
	/** Tool use ID (for linking to tool events) */
	toolUseId?: string;
}

export interface CorrectionGapResult {
	/** File where correction occurred */
	filePath: string;
	/** Original agent edit */
	agentEdit: TrackedEdit;
	/** User's correction edit */
	userEdit: TrackedEdit;
	/** Type of correction */
	correctionType: CorrectionType;
	/** Time between agent edit and user correction (ms) */
	timeDeltaMs: number;
	/** Overlap ratio (0-1) between edit regions */
	overlapRatio: number;
}

export interface CorrectionGapStats {
	/** Total agent edits tracked */
	totalAgentEdits: number;
	/** Edits that were modified by user */
	modifiedByUser: number;
	/** Edits that were unchanged (adopted) */
	adoptedAsIs: number;
	/** Edits that were completely undone */
	undone: number;
	/** Adoption rate (0-1) */
	adoptionRate: number;
	/** Modification rate (0-1) */
	modificationRate: number;
	/** Average time to user modification (ms) */
	avgTimeToModification: number;
	/** Files with most corrections */
	topCorrectedFiles: Array<{ filePath: string; count: number }>;
}

export interface CodeChangeTrackerConfig {
	/** Time window (ms) to look for user corrections after agent edit */
	correctionWindowMs: number;
	/** Minimum overlap ratio to consider overlapping */
	minOverlapRatio: number;
	/** Maximum edits to keep in memory per session */
	maxEditsPerSession: number;
}

export const DEFAULT_TRACKER_CONFIG: CodeChangeTrackerConfig = {
	correctionWindowMs: 5 * 60 * 1000, // 5 minutes
	minOverlapRatio: 0.3,
	maxEditsPerSession: 100,
};

// ============================================================================
// CodeChangeTracker Class
// ============================================================================

export class CodeChangeTracker {
	private store: InteractionStore;
	private config: CodeChangeTrackerConfig;

	/** In-memory cache of recent edits by session */
	private sessionEdits: Map<string, TrackedEdit[]> = new Map();

	/** File path -> most recent agent edit for quick lookup */
	private recentAgentEdits: Map<string, TrackedEdit> = new Map();

	constructor(
		store: InteractionStore,
		config: Partial<CodeChangeTrackerConfig> = {},
	) {
		this.store = store;
		this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
	}

	/**
	 * Track an agent edit.
	 */
	trackAgentEdit(edit: Omit<TrackedEdit, "author" | "timestamp">): TrackedEdit {
		const trackedEdit: TrackedEdit = {
			...edit,
			author: "agent",
			timestamp: Date.now(),
		};

		// Add to session cache
		this.addToSessionCache(trackedEdit);

		// Update recent agent edits index
		this.recentAgentEdits.set(edit.filePath, trackedEdit);

		// Persist to database
		this.persistEdit(trackedEdit);

		return trackedEdit;
	}

	/**
	 * Track a user edit and check for corrections.
	 */
	trackUserEdit(edit: Omit<TrackedEdit, "author" | "timestamp">): {
		trackedEdit: TrackedEdit;
		correction?: CorrectionGapResult;
	} {
		const trackedEdit: TrackedEdit = {
			...edit,
			author: "user",
			timestamp: Date.now(),
		};

		// Add to session cache
		this.addToSessionCache(trackedEdit);

		// Check if this is a correction of a recent agent edit
		const correction = this.detectCorrection(trackedEdit);

		// Persist to database
		this.persistEdit(trackedEdit, correction);

		return { trackedEdit, correction };
	}

	/**
	 * Get recent agent edits for a file.
	 */
	getRecentAgentEdits(filePath: string, sessionId?: string): TrackedEdit[] {
		const now = Date.now();
		const results: TrackedEdit[] = [];

		// Check session cache
		if (sessionId) {
			const edits = this.sessionEdits.get(sessionId) || [];
			for (const edit of edits) {
				if (
					edit.author === "agent" &&
					edit.filePath === filePath &&
					now - edit.timestamp < this.config.correctionWindowMs
				) {
					results.push(edit);
				}
			}
		}

		// Check recent agent edits index
		const recent = this.recentAgentEdits.get(filePath);
		if (
			recent &&
			now - recent.timestamp < this.config.correctionWindowMs &&
			!results.includes(recent)
		) {
			results.push(recent);
		}

		return results.sort((a, b) => b.timestamp - a.timestamp);
	}

	/**
	 * Calculate correction gap statistics for a session.
	 */
	getSessionStats(sessionId: string): CorrectionGapStats | null {
		const edits = this.sessionEdits.get(sessionId);
		if (!edits || edits.length === 0) {
			return null;
		}

		const agentEdits = edits.filter((e) => e.author === "agent");
		const userEdits = edits.filter((e) => e.author === "user");

		if (agentEdits.length === 0) {
			return null;
		}

		// Track which agent edits were modified
		const corrections = new Map<TrackedEdit, CorrectionGapResult>();
		const fileCorrectionCounts = new Map<string, number>();

		for (const userEdit of userEdits) {
			const recentAgentEdits = agentEdits.filter(
				(ae) =>
					ae.filePath === userEdit.filePath &&
					userEdit.timestamp - ae.timestamp < this.config.correctionWindowMs,
			);

			for (const agentEdit of recentAgentEdits) {
				const overlap = this.calculateOverlap(agentEdit, userEdit);
				if (overlap >= this.config.minOverlapRatio) {
					const correctionType = this.classifyCorrection(agentEdit, userEdit);
					corrections.set(agentEdit, {
						filePath: agentEdit.filePath,
						agentEdit,
						userEdit,
						correctionType,
						timeDeltaMs: userEdit.timestamp - agentEdit.timestamp,
						overlapRatio: overlap,
					});

					const count = fileCorrectionCounts.get(agentEdit.filePath) || 0;
					fileCorrectionCounts.set(agentEdit.filePath, count + 1);
				}
			}
		}

		const modifiedByUser = corrections.size;
		const undone = [...corrections.values()].filter(
			(c) => c.correctionType === "undo",
		).length;
		const adoptedAsIs = agentEdits.length - modifiedByUser;

		const timeDeltas = [...corrections.values()].map((c) => c.timeDeltaMs);
		const avgTimeToModification =
			timeDeltas.length > 0
				? timeDeltas.reduce((a, b) => a + b, 0) / timeDeltas.length
				: 0;

		const topCorrectedFiles = [...fileCorrectionCounts.entries()]
			.map(([filePath, count]) => ({ filePath, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		return {
			totalAgentEdits: agentEdits.length,
			modifiedByUser,
			adoptedAsIs,
			undone,
			adoptionRate: adoptedAsIs / agentEdits.length,
			modificationRate: modifiedByUser / agentEdits.length,
			avgTimeToModification,
			topCorrectedFiles,
		};
	}

	/**
	 * Cleanup old edits from memory cache.
	 */
	cleanup(): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [sessionId, edits] of this.sessionEdits) {
			const filtered = edits.filter(
				(e) => now - e.timestamp < this.config.correctionWindowMs * 2,
			);
			if (filtered.length !== edits.length) {
				cleaned += edits.length - filtered.length;
				if (filtered.length === 0) {
					this.sessionEdits.delete(sessionId);
				} else {
					this.sessionEdits.set(sessionId, filtered);
				}
			}
		}

		// Cleanup recent agent edits
		for (const [filePath, edit] of this.recentAgentEdits) {
			if (now - edit.timestamp > this.config.correctionWindowMs * 2) {
				this.recentAgentEdits.delete(filePath);
				cleaned++;
			}
		}

		return cleaned;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Add edit to session cache with size limit.
	 */
	private addToSessionCache(edit: TrackedEdit): void {
		let edits = this.sessionEdits.get(edit.sessionId);
		if (!edits) {
			edits = [];
			this.sessionEdits.set(edit.sessionId, edits);
		}

		edits.push(edit);

		// Enforce size limit
		if (edits.length > this.config.maxEditsPerSession) {
			edits.shift();
		}
	}

	/**
	 * Detect if user edit is a correction of agent edit.
	 */
	private detectCorrection(
		userEdit: TrackedEdit,
	): CorrectionGapResult | undefined {
		const recentAgentEdits = this.getRecentAgentEdits(
			userEdit.filePath,
			userEdit.sessionId,
		);

		for (const agentEdit of recentAgentEdits) {
			const overlap = this.calculateOverlap(agentEdit, userEdit);
			if (overlap >= this.config.minOverlapRatio) {
				return {
					filePath: userEdit.filePath,
					agentEdit,
					userEdit,
					correctionType: this.classifyCorrection(agentEdit, userEdit),
					timeDeltaMs: userEdit.timestamp - agentEdit.timestamp,
					overlapRatio: overlap,
				};
			}
		}

		return undefined;
	}

	/**
	 * Calculate overlap ratio between two edits.
	 */
	private calculateOverlap(edit1: TrackedEdit, edit2: TrackedEdit): number {
		// If no line info, check content hash
		if (edit1.startLine === undefined || edit2.startLine === undefined) {
			// Same file is minimum overlap
			return edit1.filePath === edit2.filePath ? 0.5 : 0;
		}

		const start1 = edit1.startLine;
		const end1 = edit1.endLine ?? edit1.startLine;
		const start2 = edit2.startLine;
		const end2 = edit2.endLine ?? edit2.startLine;

		// Calculate overlap
		const overlapStart = Math.max(start1, start2);
		const overlapEnd = Math.min(end1, end2);

		if (overlapStart > overlapEnd) {
			return 0; // No overlap
		}

		const overlapSize = overlapEnd - overlapStart + 1;
		const edit1Size = end1 - start1 + 1;
		const edit2Size = end2 - start2 + 1;

		// Return overlap as fraction of smaller edit
		return overlapSize / Math.min(edit1Size, edit2Size);
	}

	/**
	 * Classify the type of correction.
	 */
	private classifyCorrection(
		agentEdit: TrackedEdit,
		userEdit: TrackedEdit,
	): CorrectionType {
		// If user removed lines and added nothing, it's an undo
		if (userEdit.linesAdded === 0 && userEdit.linesRemoved > 0) {
			return "undo";
		}

		// If user added lines but removed none, it's an enhancement
		if (userEdit.linesAdded > 0 && userEdit.linesRemoved === 0) {
			return "enhance";
		}

		// If lines were both added and removed
		if (userEdit.linesAdded > 0 && userEdit.linesRemoved > 0) {
			// If removed more than added, likely correcting mistakes
			if (userEdit.linesRemoved > userEdit.linesAdded * 2) {
				return "undo";
			}
			// Otherwise it's an enhancement
			return "enhance";
		}

		return "independent";
	}

	/**
	 * Persist edit to database.
	 */
	private persistEdit(
		edit: TrackedEdit,
		correction?: CorrectionGapResult,
	): void {
		const codeChange: Omit<CodeChange, "id"> = {
			sessionId: edit.sessionId,
			filePath: edit.filePath,
			author: edit.author,
			diffHash: edit.contentHash,
			linesAdded: edit.linesAdded,
			linesRemoved: edit.linesRemoved,
			timestamp: edit.timestamp,
			agentChangeId: undefined,
			correctionType: correction?.correctionType,
		};

		this.store.recordCodeChange(codeChange);

		// If this is a correction, also log a correction event
		if (correction) {
			this.store.recordCorrection({
				sessionId: edit.sessionId,
				correctionScore: Math.min(1.0, correction.overlapRatio),
				signals: {
					lexical: 0,
					pivot: 0,
					overwrite: correction.overlapRatio,
					reask: 0,
				},
				triggerEvent: `User modified ${correction.filePath} after agent edit`,
				agentAction: `Agent edited ${correction.filePath}`,
				timestamp: edit.timestamp,
			});
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a code change tracker.
 */
export function createCodeChangeTracker(
	store: InteractionStore,
	config: Partial<CodeChangeTrackerConfig> = {},
): CodeChangeTracker {
	return new CodeChangeTracker(store, config);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a content hash for comparing edits.
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}
