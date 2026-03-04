/**
 * URL pattern router for the cloud test server.
 * Hand-written pattern matching — no framework dependency.
 */

import type { ServerConfig } from "./config.js";
import type { Sql } from "./db.js";

// ============================================================================
// Request metrics
// ============================================================================

export interface RequestMetrics {
	// --- Identity signals (set by middleware or handlers) ---

	/** The organisation slug from the route or request body (e.g., "acme") */
	orgSlug?: string;
	/** The repository slug from the route or request body (e.g., "backend") */
	repoSlug?: string;
	/** 40-char hex commit SHA — correlation key across the index pipeline */
	commitSha?: string;
	/** Anonymous machine UUID from X-ClaudeMem-Machine-ID header */
	machineId?: string;

	// --- Index upload (POST /v1/index) ---

	/** "thin" (vectors pre-computed by CLI) or "smart" (server embeds) */
	mode?: "thin" | "smart";
	/** Total chunks sent in this upload (chunksNew + chunksDeduped) */
	chunksTotal?: number;
	/** Chunks that were not already in the database (newly inserted) */
	chunksNew?: number;
	/** Chunks already present by content_hash (not re-stored) */
	chunksDeduped?: number;
	/** Unique file paths in the upload (changed files) */
	filesChanged?: number;
	/** Files inherited from parent commit unchanged */
	filesInherited?: number;

	// --- Chunk dedup check (POST /v1/chunks/check) ---

	/** Total hashes submitted to the check endpoint */
	hashesChecked?: number;
	/** Hashes that already exist in the database */
	hashesExisting?: number;
	/** Hashes that do not exist and must be uploaded */
	hashesMissing?: number;

	// --- Search (POST /v1/search) ---

	/** Dimension of the query vector (used to detect version skew) */
	queryDim?: number;
	/** Number of search results returned (0 indicates empty index or bad query) */
	resultsReturned?: number;
	/** Duration of the pgvector query only, in milliseconds */
	searchMs?: number;

	// --- Commit status (GET /v1/commits/:sha/status) ---

	/** Status string returned: "ready", "pending", "embedding", "not_found", "error" */
	commitStatus?: string;

	// --- Error tracking (all endpoints) ---

	/** Machine-readable error code, e.g. "repo_not_found", "dimension_mismatch" */
	errorCode?: string;

	// --- Slow request flag ---

	/** True if request exceeded the slow-request threshold for this endpoint */
	slow?: boolean;

	// --- Auth ---

	/** ID of the authenticated API key (undefined if master key or auth disabled) */
	apiKeyId?: number;
	/** Source of auth: "master" | "key" | "none" */
	apiKeySource?: "master" | "key" | "none";
}

// ============================================================================
// Request context
// ============================================================================

export interface RequestContext {
	req: Request;
	method: string;
	pathname: string;
	params: Record<string, string>;
	query: URLSearchParams;
	/** Database connection */
	sql: Sql;
	/** Server configuration */
	config: ServerConfig;
	/** Per-request telemetry bag — handlers write here; fetch wrapper reads for logging */
	metrics: Partial<RequestMetrics>;
}

// ============================================================================
// Route matching
// ============================================================================

interface RoutePattern {
	method: string;
	/** Pattern segments, e.g. ["v1", "repos", ":orgSlug", ":repoSlug", "register"] */
	segments: string[];
}

function parsePattern(pattern: string): string[] {
	return pattern.split("/").filter((s) => s.length > 0);
}

function matchRoute(
	pattern: RoutePattern,
	method: string,
	segments: string[],
): Record<string, string> | null {
	if (pattern.method !== method) return null;
	if (pattern.segments.length !== segments.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.segments.length; i++) {
		const pat = pattern.segments[i]!;
		const seg = segments[i]!;
		if (pat.startsWith(":")) {
			params[pat.slice(1)] = decodeURIComponent(seg);
		} else if (pat !== seg) {
			return null;
		}
	}
	return params;
}

// ============================================================================
// Handler imports
// ============================================================================

import { check } from "./handlers/chunks.js";
import { uploadIndex } from "./handlers/index-handler.js";
import { createKey, deleteKey, listKeys } from "./handlers/keys.js";
import { register } from "./handlers/repos.js";
import { search } from "./handlers/search.js";
import { getStatus } from "./handlers/status.js";

// ============================================================================
// Route table
// ============================================================================

type HandlerFn = (ctx: RequestContext) => Promise<Response>;

interface Route {
	pattern: RoutePattern;
	handler: HandlerFn;
}

const routes: Route[] = [
	{
		pattern: {
			method: "POST",
			segments: parsePattern("/v1/repos/:orgSlug/:repoSlug/register"),
		},
		handler: register,
	},
	{
		pattern: {
			method: "POST",
			segments: parsePattern("/v1/chunks/check"),
		},
		handler: check,
	},
	{
		pattern: {
			method: "POST",
			segments: parsePattern("/v1/index"),
		},
		handler: uploadIndex,
	},
	{
		pattern: {
			method: "GET",
			segments: parsePattern("/v1/commits/:sha/status"),
		},
		handler: getStatus,
	},
	{
		pattern: {
			method: "POST",
			segments: parsePattern("/v1/search"),
		},
		handler: search,
	},
	{
		pattern: {
			method: "GET",
			segments: parsePattern("/v1/health"),
		},
		handler: async (_ctx) => json({ ok: true }, 200),
	},
	{
		pattern: {
			method: "POST",
			segments: parsePattern("/v1/keys"),
		},
		handler: createKey,
	},
	{
		pattern: {
			method: "GET",
			segments: parsePattern("/v1/keys"),
		},
		handler: listKeys,
	},
	{
		pattern: {
			method: "DELETE",
			segments: parsePattern("/v1/keys/:keyId"),
		},
		handler: deleteKey,
	},
];

// ============================================================================
// Router dispatch
// ============================================================================

export async function router(ctx: RequestContext): Promise<Response> {
	const pathSegments = ctx.pathname.split("/").filter((s) => s.length > 0);

	for (const route of routes) {
		const params = matchRoute(route.pattern, ctx.method, pathSegments);
		if (params !== null) {
			ctx.params = params;
			try {
				return await route.handler(ctx);
			} catch (err) {
				console.error(
					`[server] Unhandled error in ${ctx.method} ${ctx.pathname}:`,
					err,
				);
				const message = err instanceof Error ? err.message : String(err);
				ctx.metrics.errorCode = "internal_error";
				return json({ error: "internal_error", message }, 500);
			}
		}
	}

	return json({ error: "not_found" }, 404);
}

// ============================================================================
// Helpers
// ============================================================================

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
