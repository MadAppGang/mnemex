/**
 * API key management handlers.
 *
 * POST   /v1/keys         — createKey
 * GET    /v1/keys         — listKeys
 * DELETE /v1/keys/:keyId  — deleteKey
 *
 * All endpoints require master key (enforced by authMiddleware before reaching here).
 */

import { createHash, randomBytes } from "node:crypto";
import type { RequestContext } from "../router.js";
import { json } from "../router.js";

// ============================================================================
// Key generation
// ============================================================================

function generateApiKey(): { key: string; hash: string; prefix: string } {
	const raw = randomBytes(16).toString("hex"); // 32 hex chars
	const key = `cmem_${raw}`; // e.g. cmem_a1b2c3d4e5f6...
	const hash = createHash("sha256").update(key).digest("hex");
	const prefix = raw.slice(0, 8); // first 8 hex chars of random part
	return { key, hash, prefix };
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /v1/keys — Create a new API key.
 * Returns the full secret once (not stored in DB after this point).
 */
export async function createKey(ctx: RequestContext): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await ctx.req.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "invalid_json" }, 400);
	}

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		return json({ error: "missing_field", field: "name" }, 400);
	}

	const { key, hash, prefix } = generateApiKey();

	const rows = await ctx.sql<{ id: number; created_at: Date }[]>`
		INSERT INTO api_keys (key_hash, key_prefix, name)
		VALUES (${hash}, ${prefix}, ${name})
		RETURNING id, created_at
	`;
	const row = rows[0]!;

	return json(
		{
			ok: true,
			key: {
				id: row.id,
				name,
				prefix,
				createdAt: row.created_at.toISOString(),
				lastUsedAt: null,
				isActive: true,
			},
			secret: key,
		},
		201,
	);
}

/**
 * GET /v1/keys — List all API keys with usage stats.
 */
export async function listKeys(ctx: RequestContext): Promise<Response> {
	const keys = await ctx.sql<
		{
			id: number;
			name: string;
			key_prefix: string;
			created_at: Date;
			last_used_at: Date | null;
			is_active: boolean;
		}[]
	>`
		SELECT id, name, key_prefix, created_at, last_used_at, is_active
		FROM api_keys
		ORDER BY created_at DESC
	`;

	// Aggregate usage per key in one query
	const keyIds = keys.map((k) => k.id);
	const usageRows =
		keyIds.length > 0
			? await ctx.sql<{ key_id: number; endpoint: string; cnt: string }[]>`
			SELECT key_id, endpoint, COUNT(*)::text AS cnt
			FROM api_key_usage
			WHERE key_id = ANY(${keyIds}::int[])
			GROUP BY key_id, endpoint
		`
			: [];

	// Build usage map
	const usageMap = new Map<
		number,
		{ total: number; byEndpoint: Record<string, number> }
	>();
	for (const row of usageRows) {
		const entry = usageMap.get(row.key_id) ?? {
			total: 0,
			byEndpoint: {} as Record<string, number>,
		};
		const cnt = Number.parseInt(row.cnt, 10);
		entry.total += cnt;
		entry.byEndpoint[row.endpoint] = cnt;
		usageMap.set(row.key_id, entry);
	}

	return json({
		keys: keys.map((k) => ({
			id: k.id,
			name: k.name,
			prefix: k.key_prefix,
			createdAt: k.created_at.toISOString(),
			lastUsedAt: k.last_used_at?.toISOString() ?? null,
			isActive: k.is_active,
			usage: usageMap.get(k.id) ?? { total: 0, byEndpoint: {} },
		})),
	});
}

/**
 * DELETE /v1/keys/:keyId — Hard delete an API key.
 * Usage rows cascade via FK ON DELETE CASCADE.
 */
export async function deleteKey(ctx: RequestContext): Promise<Response> {
	const keyId = Number.parseInt(ctx.params.keyId ?? "", 10);
	if (!Number.isFinite(keyId)) {
		return json({ error: "invalid_param" }, 400);
	}

	const result = await ctx.sql<{ id: number }[]>`
		DELETE FROM api_keys WHERE id = ${keyId} RETURNING id
	`;

	if (result.length === 0) {
		return json({ error: "not_found" }, 404);
	}

	return json({ ok: true, deleted: true });
}
