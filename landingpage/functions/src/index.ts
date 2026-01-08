/**
 * Firebase Cloud Functions for claudemem Benchmark Results
 *
 * These functions handle benchmark result uploads securely without
 * exposing Firebase credentials in the client code.
 *
 * Security:
 * - API key required for write operations (X-API-Key header)
 * - Rate limiting on uploads (10 per minute per IP)
 */

import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK (uses default credentials in Cloud Functions)
if (getApps().length === 0) {
	initializeApp();
}

const db = getFirestore();

// ============================================================================
// Security: API Key (hardcoded for simplicity - rate limiting provides protection)
// ============================================================================

const API_KEY = "6QgFCtDx9l9alTpb813ZbgHoy2yZBfHc";

// ============================================================================
// Rate Limiting (in-memory, resets on cold start)
// ============================================================================

interface RateLimitEntry {
	count: number;
	resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 uploads per minute per IP

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now > entry.resetTime) {
		// New window
		rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}

	if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
		return true;
	}

	entry.count++;
	return false;
}

function getClientIP(req: {
	ip?: string;
	headers: Record<string, string | string[] | undefined>;
}): string {
	// Cloud Functions sets the client IP in x-forwarded-for
	const forwarded = req.headers["x-forwarded-for"];
	if (forwarded) {
		const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
		return ips.split(",")[0].trim();
	}
	return req.ip || "unknown";
}

// ============================================================================
// Types (mirrored from client for validation)
// ============================================================================

interface ModelScoreEntry {
	modelId: string;
	displayName: string;
	quality: {
		retrieval: number;
		contrastive: number;
		judge: number;
		overall: number;
	};
	operational: {
		latencyMs: number;
		cost: number;
		refinementRounds: number;
		selfEvalScore: number;
	};
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

interface BenchmarkUploadPayload {
	runId: string;
	projectName: string;
	projectPath: string;
	codebaseType: {
		language: string;
		category: string;
		stack: string;
		label: string;
		tags: string[];
	};
	generators: string[];
	judges: string[];
	sampleSize: number;
	durationMs: number;
	totalCost: number;
	modelScores: ModelScoreEntry[];
	claudememVersion: string;
	machineId?: string;
}

interface LeaderboardEntry {
	modelId: string;
	displayName: string;
	runCount: number;
	avgQualityScore: number;
	avgRetrievalScore: number;
	avgContrastiveScore: number;
	avgJudgeScore: number;
	bestQualityScore: number;
	lastRunTimestamp: Timestamp;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function isValidNumber(val: unknown): val is number {
	return typeof val === "number" && !isNaN(val) && isFinite(val);
}

function isValidString(val: unknown): val is string {
	return typeof val === "string" && val.length > 0;
}

function isValidArray(val: unknown): val is unknown[] {
	return Array.isArray(val);
}

function validateModelScore(score: unknown): score is ModelScoreEntry {
	if (!score || typeof score !== "object") return false;
	const s = score as Record<string, unknown>;

	return (
		isValidString(s.modelId) &&
		isValidString(s.displayName) &&
		typeof s.quality === "object" &&
		s.quality !== null &&
		typeof s.operational === "object" &&
		s.operational !== null &&
		typeof s.details === "object" &&
		s.details !== null
	);
}

function validatePayload(data: unknown): data is BenchmarkUploadPayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;

	// Required string fields
	if (!isValidString(d.runId)) return false;
	if (!isValidString(d.projectName)) return false;
	if (!isValidString(d.projectPath)) return false;
	if (!isValidString(d.claudememVersion)) return false;

	// Required number fields
	if (!isValidNumber(d.sampleSize)) return false;
	if (!isValidNumber(d.durationMs)) return false;
	if (!isValidNumber(d.totalCost)) return false;

	// Required arrays
	if (!isValidArray(d.generators)) return false;
	if (!isValidArray(d.judges)) return false;
	if (!isValidArray(d.modelScores)) return false;

	// Validate codebaseType
	if (!d.codebaseType || typeof d.codebaseType !== "object") return false;
	const ct = d.codebaseType as Record<string, unknown>;
	if (!isValidString(ct.language)) return false;
	if (!isValidString(ct.category)) return false;
	if (!isValidString(ct.stack)) return false;
	if (!isValidString(ct.label)) return false;
	if (!isValidArray(ct.tags)) return false;

	// Validate model scores
	for (const score of d.modelScores as unknown[]) {
		if (!validateModelScore(score)) return false;
	}

	return true;
}

// ============================================================================
// Cloud Functions
// ============================================================================

/**
 * Upload benchmark results to Firestore
 *
 * POST /uploadBenchmarkResults
 * Headers: X-API-Key (required)
 * Body: BenchmarkUploadPayload
 */
export const uploadBenchmarkResults = onRequest(
	{
		cors: true, // Allow CORS for CLI clients
		maxInstances: 10,
		timeoutSeconds: 60,
	},
	async (req, res) => {
		// Only allow POST
		if (req.method !== "POST") {
			res.status(405).json({ error: "Method not allowed" });
			return;
		}

		// Validate API key
		const apiKey = req.headers["x-api-key"];
		const expectedKey = API_KEY;
		if (!apiKey || apiKey !== expectedKey) {
			res.status(401).json({ error: "Invalid or missing API key" });
			return;
		}

		// Check rate limit
		const clientIP = getClientIP(req);
		if (isRateLimited(clientIP)) {
			res.status(429).json({
				error: "Rate limit exceeded",
				message: "Maximum 10 uploads per minute. Please try again later.",
			});
			return;
		}

		try {
			const payload = req.body;

			// Validate payload
			if (!validatePayload(payload)) {
				res.status(400).json({ error: "Invalid payload structure" });
				return;
			}

			// Create the run document
			const runDoc = {
				runId: payload.runId,
				timestamp: Timestamp.now(),
				projectName: payload.projectName,
				projectPath: payload.projectPath,
				codebaseType: payload.codebaseType,
				generators: payload.generators,
				judges: payload.judges,
				sampleSize: payload.sampleSize,
				status: "completed" as const,
				durationMs: payload.durationMs,
				totalCost: payload.totalCost,
				modelScores: payload.modelScores,
				claudememVersion: payload.claudememVersion,
				machineId: payload.machineId || null,
			};

			// Write to Firestore
			const docRef = db.collection("benchmark_runs").doc(payload.runId);
			await docRef.set(runDoc);

			// Update leaderboard entries
			await updateLeaderboard(payload.modelScores);

			res.status(200).json({
				success: true,
				docId: payload.runId,
			});
		} catch (error) {
			console.error("Upload error:", error);
			res.status(500).json({
				error: "Internal server error",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		}
	},
);

/**
 * Update the leaderboard with new model scores
 */
async function updateLeaderboard(
	modelScores: ModelScoreEntry[],
): Promise<void> {
	const batch = db.batch();

	for (const score of modelScores) {
		// Firestore doesn't allow / in doc IDs
		const docId = score.modelId.replace(/\//g, "_");
		const leaderboardRef = db.collection("benchmark_leaderboard").doc(docId);

		// Get existing entry
		const existing = await leaderboardRef.get();
		const existingData = existing.data() as LeaderboardEntry | undefined;

		const runCount = (existingData?.runCount || 0) + 1;

		const newEntry: LeaderboardEntry = {
			modelId: score.modelId,
			displayName: score.displayName,
			runCount,
			avgQualityScore: existingData
				? (existingData.avgQualityScore * existingData.runCount +
						score.quality.overall) /
					runCount
				: score.quality.overall,
			avgRetrievalScore: existingData
				? (existingData.avgRetrievalScore * existingData.runCount +
						score.quality.retrieval) /
					runCount
				: score.quality.retrieval,
			avgContrastiveScore: existingData
				? (existingData.avgContrastiveScore * existingData.runCount +
						score.quality.contrastive) /
					runCount
				: score.quality.contrastive,
			avgJudgeScore: existingData
				? (existingData.avgJudgeScore * existingData.runCount +
						score.quality.judge) /
					runCount
				: score.quality.judge,
			bestQualityScore: Math.max(
				existingData?.bestQualityScore || 0,
				score.quality.overall,
			),
			lastRunTimestamp: Timestamp.now(),
		};

		batch.set(leaderboardRef, newEntry);
	}

	await batch.commit();
}

/**
 * Get the leaderboard (top models by average quality score)
 *
 * GET /getLeaderboard?limit=20
 */
export const getLeaderboard = onRequest(
	{
		cors: true,
		maxInstances: 10,
	},
	async (req, res) => {
		if (req.method !== "GET") {
			res.status(405).json({ error: "Method not allowed" });
			return;
		}

		try {
			const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

			const snapshot = await db
				.collection("benchmark_leaderboard")
				.orderBy("avgQualityScore", "desc")
				.limit(limit)
				.get();

			const entries = snapshot.docs.map((doc) => doc.data());

			res.status(200).json({ entries });
		} catch (error) {
			console.error("Leaderboard error:", error);
			res.status(500).json({ error: "Failed to fetch leaderboard" });
		}
	},
);

/**
 * Get recent benchmark runs
 *
 * GET /getRecentRuns?limit=10
 */
export const getRecentRuns = onRequest(
	{
		cors: true,
		maxInstances: 10,
	},
	async (req, res) => {
		if (req.method !== "GET") {
			res.status(405).json({ error: "Method not allowed" });
			return;
		}

		try {
			const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

			const snapshot = await db
				.collection("benchmark_runs")
				.orderBy("timestamp", "desc")
				.limit(limit)
				.get();

			const runs = snapshot.docs.map((doc) => doc.data());

			res.status(200).json({ runs });
		} catch (error) {
			console.error("Recent runs error:", error);
			res.status(500).json({ error: "Failed to fetch recent runs" });
		}
	},
);

/**
 * Health check endpoint
 *
 * GET /health
 */
export const health = onRequest({ cors: true }, async (_req, res) => {
	res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});
