/**
 * Middleware chain for the cloud test server.
 *
 * Auth middleware validates Authorization: Bearer <key> on all /v1/* endpoints.
 * When MASTER_API_KEY is not configured, auth is disabled (dev/test mode).
 */

import { createHash } from "node:crypto";
import type { RequestContext } from "./router.js";
import { json } from "./router.js";

// ============================================================================
// Auth middleware
// ============================================================================

/**
 * authMiddleware
 *
 * Validates Authorization: Bearer <key> header on all /v1/* endpoints.
 * Skips /v1/health unconditionally.
 * When MASTER_API_KEY is not set in config → auth disabled (dev/test mode).
 *
 * Sets ctx.metrics.apiKeyId on success for downstream usage tracking.
 */
export async function authMiddleware(
	ctx: RequestContext,
): Promise<Response | null> {
	// Auth disabled when no master key configured
	if (!ctx.config.masterApiKey) return null;

	// Always allow health check
	if (ctx.pathname === "/v1/health") return null;

	// Extract Bearer token
	const authHeader = ctx.req.headers.get("Authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
	if (!token) {
		return json({ error: "unauthorized" }, 401);
	}

	// Master key: validate by direct comparison (not stored in DB)
	if (token === ctx.config.masterApiKey) {
		ctx.metrics.apiKeySource = "master";
		return null;
	}

	// Regular key: hash and look up in DB
	const hash = createHash("sha256").update(token).digest("hex");

	const rows = await ctx.sql<
		{ id: number; name: string; is_active: boolean }[]
	>`
		SELECT id, name, is_active
		FROM api_keys
		WHERE key_hash = ${hash}
		LIMIT 1
	`;

	if (rows.length === 0 || !rows[0]!.is_active) {
		return json({ error: "forbidden" }, 403);
	}

	// Key management endpoints require master key only
	if (ctx.pathname.startsWith("/v1/keys")) {
		return json({ error: "forbidden" }, 403);
	}

	ctx.metrics.apiKeyId = rows[0]!.id;
	ctx.metrics.apiKeySource = "key";
	return null;
}

// ============================================================================
// Version middleware
// ============================================================================

export async function versionMiddleware(
	ctx: RequestContext,
): Promise<Response | null> {
	// Skip version check for health endpoint
	if (ctx.pathname === "/v1/health") return null;

	const version = ctx.req.headers.get("X-ClaudeMem-Version");
	if (!version || version !== "1") {
		return json({ error: "unsupported_version", supported: [1] }, 422);
	}

	// Extract anonymous machine ID for telemetry.
	// Gracefully absent for older clients — log null is fine.
	const machineId = ctx.req.headers.get("X-ClaudeMem-Machine-ID");
	if (machineId) {
		ctx.metrics.machineId = machineId;
	}

	return null;
}

// ============================================================================
// Middleware runner
// ============================================================================

type MiddlewareFn = (ctx: RequestContext) => Promise<Response | null>;

export async function runMiddleware(
	ctx: RequestContext,
	middlewares: MiddlewareFn[],
): Promise<Response | null> {
	for (const mw of middlewares) {
		const result = await mw(ctx);
		if (result !== null) return result;
	}
	return null;
}
