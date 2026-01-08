/**
 * Firebase Integration for Benchmark Results
 *
 * Uploads benchmark results via Cloud Functions (no credentials in client code).
 *
 * Cloud Function Endpoints:
 * - POST /uploadBenchmarkResults - Upload benchmark run
 * - GET /getLeaderboard - Get top models
 * - GET /getRecentRuns - Get recent benchmark runs
 */

import type { NormalizedScores } from "../types.js";

// ============================================================================
// Cloud Function Configuration
// ============================================================================

// Cloud Function base URL (deployed to us-central1 by default)
const CLOUD_FUNCTION_BASE_URL =
	process.env.CLAUDEMEM_FIREBASE_URL ||
	"https://us-central1-claudish-6da10.cloudfunctions.net";

// API key for authenticated uploads (provides basic abuse protection)
const API_KEY =
	process.env.CLAUDEMEM_API_KEY || "6QgFCtDx9l9alTpb813ZbgHoy2yZBfHc";

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkRunDocument {
	runId: string;
	timestamp: string; // ISO string (Cloud Function adds server Timestamp)
	projectName: string;
	projectPath: string;

	// Codebase type (for filtering/comparison)
	codebaseType: {
		language: string;
		category: string;
		stack: string;
		label: string;
		tags: string[];
	};

	// Configuration
	generators: string[];
	judges: string[];
	sampleSize: number;

	// Results
	status: "completed" | "failed" | "partial";
	durationMs: number;
	totalCost: number;

	// Model scores (embedded for easy querying)
	modelScores: ModelScoreEntry[];

	// Metadata
	claudememVersion: string;
	machineId?: string;
}

export interface ModelScoreEntry {
	modelId: string;
	displayName: string;

	// Quality scores (0-1)
	quality: {
		retrieval: number;
		contrastive: number;
		judge: number;
		overall: number;
	};

	// Operational metrics
	operational: {
		latencyMs: number;
		cost: number;
		refinementRounds: number;
		selfEvalScore: number;
	};

	// Detailed breakdowns
	details: {
		judge: {
			pointwise: number;
			pairwise: number;
		};
		retrieval: {
			precision1: number;
			precision5: number;
			mrr: number;
		};
		selfEval?: {
			retrieval: number;
			functionSelection: number;
		};
		iterative?: {
			avgRounds: number;
			successRate: number;
		};
	};
}

export interface LeaderboardEntry {
	modelId: string;
	displayName: string;
	runCount: number;
	avgQualityScore: number;
	avgRetrievalScore: number;
	avgContrastiveScore: number;
	avgJudgeScore: number;
	bestQualityScore: number;
	lastRunTimestamp: string; // ISO string from server
}

// ============================================================================
// HTTP Client Helpers
// ============================================================================

/**
 * Upload benchmark results via Cloud Function
 */
export async function uploadBenchmarkResults(
	runId: string,
	projectName: string,
	projectPath: string,
	codebaseType: {
		language: string;
		category: string;
		stack: string;
		label: string;
		tags: string[];
	},
	generators: string[],
	judges: string[],
	sampleSize: number,
	durationMs: number,
	totalCost: number,
	scores: Map<string, NormalizedScores>,
	latencyByModel: Map<string, number>,
	costByModel: Map<string, number>,
): Promise<{ success: boolean; docId?: string; error?: string }> {
	const UPLOAD_TIMEOUT_MS = 30_000;

	try {
		// Build model scores array
		const modelScores: ModelScoreEntry[] = [];
		for (const [modelId, score] of scores) {
			const displayName = modelId.split("/").pop() || modelId;

			// Build details object without undefined values
			const details: ModelScoreEntry["details"] = {
				judge: {
					pointwise: score.judge.pointwise,
					pairwise: score.judge.pairwise,
				},
				retrieval: {
					precision1: score.retrieval.precision1,
					precision5: score.retrieval.precision5,
					mrr: score.retrieval.mrr,
				},
			};

			// Only add optional fields if they exist
			if (score.self) {
				details.selfEval = {
					retrieval: score.self.retrieval,
					functionSelection: score.self.functionSelection,
				};
			}
			if (score.iterative) {
				details.iterative = {
					avgRounds: score.iterative.avgRounds,
					successRate: score.iterative.successRate,
				};
			}

			modelScores.push({
				modelId,
				displayName,
				quality: {
					retrieval: score.retrieval.combined,
					contrastive: score.contrastive.combined,
					judge: score.judge.combined,
					overall: score.overall,
				},
				operational: {
					latencyMs: latencyByModel.get(modelId) || 0,
					cost: costByModel.get(modelId) || 0,
					refinementRounds: score.iterative?.avgRounds || 0,
					selfEvalScore: score.self?.overall || 0,
				},
				details,
			});
		}

		// Sort by overall quality score
		modelScores.sort((a, b) => b.quality.overall - a.quality.overall);

		// Build the payload for the Cloud Function
		const payload = {
			runId,
			projectName,
			projectPath,
			codebaseType,
			generators,
			judges,
			sampleSize,
			durationMs,
			totalCost,
			modelScores,
			claudememVersion: "0.7.0",
		};

		// POST to Cloud Function with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

		const response = await fetch(
			`${CLOUD_FUNCTION_BASE_URL}/uploadBenchmarkResults`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": API_KEY,
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			},
		);

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({}));
			return {
				success: false,
				error:
					errorData.error || `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const result = await response.json();
		return { success: true, docId: result.docId };
	} catch (error) {
		const message =
			error instanceof Error
				? error.name === "AbortError"
					? "Upload timed out"
					: error.message
				: String(error);
		return { success: false, error: message };
	}
}

/**
 * Get the leaderboard (top models by average quality score)
 */
export async function getLeaderboard(topN = 20): Promise<LeaderboardEntry[]> {
	try {
		const response = await fetch(
			`${CLOUD_FUNCTION_BASE_URL}/getLeaderboard?limit=${topN}`,
		);

		if (!response.ok) {
			console.error("Failed to get leaderboard:", response.statusText);
			return [];
		}

		const data = await response.json();
		return data.entries || [];
	} catch (error) {
		console.error("Failed to get leaderboard:", error);
		return [];
	}
}

/**
 * Get recent benchmark runs
 */
export async function getRecentRuns(
	limitCount = 10,
): Promise<BenchmarkRunDocument[]> {
	try {
		const response = await fetch(
			`${CLOUD_FUNCTION_BASE_URL}/getRecentRuns?limit=${limitCount}`,
		);

		if (!response.ok) {
			console.error("Failed to get recent runs:", response.statusText);
			return [];
		}

		const data = await response.json();
		return data.runs || [];
	} catch (error) {
		console.error("Failed to get recent runs:", error);
		return [];
	}
}

/**
 * Check if Cloud Functions are configured and accessible
 */
export async function testFirebaseConnection(): Promise<boolean> {
	try {
		const response = await fetch(`${CLOUD_FUNCTION_BASE_URL}/health`, {
			method: "GET",
		});
		return response.ok;
	} catch {
		return false;
	}
}
