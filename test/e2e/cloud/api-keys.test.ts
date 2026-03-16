/**
 * E2E tests for API key management.
 *
 * Uses a dedicated server on port 4516 with MASTER_API_KEY enabled.
 * Tests creation, listing, deletion, usage tracking, and auth enforcement.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { startServer } from "../../../src/cloud/server/index.js";

// ============================================================================
// Constants
// ============================================================================

const MASTER_KEY = "test-master-key-12345";
const PORT = 4516;
const BASE_URL = `http://localhost:${PORT}`;

const NEON_DB_URL =
	"postgresql://neondb_owner:npg_EI36BnzJUaAl@ep-broad-frog-a7tco5g6-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const PROJECT_ROOT = join(import.meta.dir, "../../..");
const SCHEMA_PATH = join(PROJECT_ROOT, "src/cloud/server/schema.sql");

// ============================================================================
// Test infra
// ============================================================================

interface AuthTestContext {
	stop: () => Promise<void>;
	resetDb: () => Promise<void>;
}

async function startAuthTestInfra(): Promise<AuthTestContext> {
	const sql = postgres(NEON_DB_URL, { max: 5 });

	// Verify connectivity
	await sql`SELECT 1`;

	// Run schema migration
	const schema = readFileSync(SCHEMA_PATH, "utf-8");
	const statements = schema
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	for (const stmt of statements) {
		await sql.unsafe(`${stmt};`);
	}

	// Clean slate
	await sql`TRUNCATE TABLE enrichment_docs, commit_files, commits, chunks, repos, orgs RESTART IDENTITY CASCADE`;
	await sql`TRUNCATE TABLE api_key_usage, api_keys RESTART IDENTITY CASCADE`;

	// Start server with auth enabled
	const { stop: serverStop } = await startServer({
		port: PORT,
		databaseUrl: NEON_DB_URL,
		embeddingDim: 8,
		masterApiKey: MASTER_KEY,
	});

	await new Promise((resolve) => setTimeout(resolve, 100));

	return {
		async stop() {
			await serverStop();
			await sql.end();
		},
		async resetDb() {
			await sql`TRUNCATE TABLE enrichment_docs, commit_files, commits, chunks, repos, orgs RESTART IDENTITY CASCADE`;
			await sql`TRUNCATE TABLE api_key_usage, api_keys RESTART IDENTITY CASCADE`;
		},
	};
}

// ============================================================================
// HTTP helper
// ============================================================================

function apiRequest(
	path: string,
	opts: { method?: string; body?: unknown; apiKey?: string } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"X-ClaudeMem-Version": "1",
		"Content-Type": "application/json",
	};
	if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
	return fetch(`${BASE_URL}${path}`, {
		method: opts.method ?? "GET",
		headers,
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
}

/** Create a synthetic 8-dimensional unit vector */
function syntheticVector(seed: number): number[] {
	const v = Array.from({ length: 8 }, (_, i) => Math.sin(seed * 1.7 + i * 0.5));
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / norm);
}

/** Generate a fake 40-char hex SHA */
function fakeSha(n: number): string {
	return n.toString(16).padStart(40, "0");
}

/** Generate a fake content hash */
function fakeHash(n: number): string {
	return `hash_${n.toString(16).padStart(62, "0")}`;
}

// ============================================================================
// Test suite
// ============================================================================

describe("E2E: API key management", () => {
	let ctx: AuthTestContext;

	beforeAll(async () => {
		ctx = await startAuthTestInfra();
	}, 30_000);

	afterAll(async () => {
		await ctx.stop();
	});

	beforeEach(async () => {
		await ctx.resetDb();
	});

	// --------------------------------------------------------------------------
	// Health is always open
	// --------------------------------------------------------------------------

	it("health always open — no auth required", async () => {
		const res = await fetch(`${BASE_URL}/v1/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ ok: true });
	});

	// --------------------------------------------------------------------------
	// Auth enforcement — no header
	// --------------------------------------------------------------------------

	it("no auth header returns 401", async () => {
		const res = await fetch(`${BASE_URL}/v1/keys`, {
			headers: { "X-ClaudeMem-Version": "1" },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toMatchObject({ error: "unauthorized" });
	});

	// --------------------------------------------------------------------------
	// Auth enforcement — invalid key
	// --------------------------------------------------------------------------

	it("invalid key returns 403", async () => {
		const res = await apiRequest("/v1/keys", {
			apiKey: "cmem_totally_bogus_key_that_does_not_exist",
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body).toMatchObject({ error: "forbidden" });
	});

	// --------------------------------------------------------------------------
	// Create key
	// --------------------------------------------------------------------------

	it("create key returns 201 with secret starting with cmem_", async () => {
		const res = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "test-key" },
			apiKey: MASTER_KEY,
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.secret).toBe("string");
		expect(body.secret).toMatch(/^cmem_/);
		expect(body.key).toMatchObject({
			id: expect.any(Number),
			name: "test-key",
			prefix: expect.any(String),
			isActive: true,
			lastUsedAt: null,
		});
	});

	// --------------------------------------------------------------------------
	// List keys
	// --------------------------------------------------------------------------

	it("list keys shows created key with prefix and usage stats", async () => {
		// Create a key first
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "list-test-key" },
			apiKey: MASTER_KEY,
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();

		// List keys
		const listRes = await apiRequest("/v1/keys", { apiKey: MASTER_KEY });
		expect(listRes.status).toBe(200);

		const listBody = await listRes.json();
		expect(Array.isArray(listBody.keys)).toBe(true);

		const found = listBody.keys.find(
			(k: { id: number }) => k.id === created.key.id,
		);
		expect(found).toBeDefined();
		expect(found).toMatchObject({
			id: created.key.id,
			name: "list-test-key",
			prefix: created.key.prefix,
			isActive: true,
			usage: { total: 0, byEndpoint: {} },
		});
	});

	// --------------------------------------------------------------------------
	// Regular key cannot access key management
	// --------------------------------------------------------------------------

	it("regular API key cannot access key management endpoints (403)", async () => {
		// Create a regular key via master
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "restricted-key" },
			apiKey: MASTER_KEY,
		});
		expect(createRes.status).toBe(201);
		const { secret } = await createRes.json();

		// Try to list keys with regular key
		const listRes = await apiRequest("/v1/keys", { apiKey: secret });
		expect(listRes.status).toBe(403);

		// Try to create another key with regular key
		const createRes2 = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "another-key" },
			apiKey: secret,
		});
		expect(createRes2.status).toBe(403);
	});

	// --------------------------------------------------------------------------
	// Regular key can use search
	// --------------------------------------------------------------------------

	it("regular API key can access POST /v1/search after indexing data", async () => {
		// Create a regular key
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "search-key" },
			apiKey: MASTER_KEY,
		});
		const { secret } = await createRes.json();

		// Register repo (using master key — setup step)
		const orgSlug = "test-org";
		const repoSlug = "api-key-test-repo";
		const registerRes = await apiRequest(
			`/v1/repos/${orgSlug}/${repoSlug}/register`,
			{ method: "POST", body: {}, apiKey: MASTER_KEY },
		);
		expect(registerRes.status).toBe(200);

		// Upload a commit with chunks
		const commitSha = fakeSha(42);
		const chunks = Array.from({ length: 3 }, (_, i) => ({
			contentHash: fakeHash(42 + i),
			filePath: `src/file_${i}.ts`,
			startLine: i * 10 + 1,
			endLine: i * 10 + 10,
			language: "typescript",
			chunkType: "function",
			name: `fn_${i}`,
			vector: syntheticVector(42 + i),
		}));

		const indexRes = await apiRequest("/v1/index", {
			method: "POST",
			body: {
				orgSlug,
				repoSlug,
				commitSha,
				parentShas: [],
				chunks,
				mode: "thin",
			},
			apiKey: MASTER_KEY,
		});
		expect(indexRes.status).toBe(202);

		// Regular key searches
		const searchRes = await apiRequest("/v1/search", {
			method: "POST",
			body: {
				repoSlug: `${orgSlug}/${repoSlug}`,
				commitSha,
				queryText: "function",
				queryVector: syntheticVector(42),
				limit: 5,
			},
			apiKey: secret,
		});
		expect(searchRes.status).toBe(200);
		const searchBody = await searchRes.json();
		expect(Array.isArray(searchBody)).toBe(true);
	});

	// --------------------------------------------------------------------------
	// Delete key
	// --------------------------------------------------------------------------

	it("delete key returns 200", async () => {
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "delete-me" },
			apiKey: MASTER_KEY,
		});
		expect(createRes.status).toBe(201);
		const { key } = await createRes.json();

		const deleteRes = await apiRequest(`/v1/keys/${key.id}`, {
			method: "DELETE",
			apiKey: MASTER_KEY,
		});
		expect(deleteRes.status).toBe(200);
		const deleteBody = await deleteRes.json();
		expect(deleteBody).toMatchObject({ ok: true, deleted: true });
	});

	// --------------------------------------------------------------------------
	// Deleted key is rejected
	// --------------------------------------------------------------------------

	it("deleted key is rejected with 403 on subsequent requests", async () => {
		// Create key
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "soon-to-be-deleted" },
			apiKey: MASTER_KEY,
		});
		expect(createRes.status).toBe(201);
		const { key, secret } = await createRes.json();

		// Verify it works — register a repo (non-key-management endpoint)
		const registerRes = await apiRequest(
			"/v1/repos/test-org/temp-repo/register",
			{
				method: "POST",
				body: {},
				apiKey: secret,
			},
		);
		expect(registerRes.status).toBe(200);

		// Delete the key
		const deleteRes = await apiRequest(`/v1/keys/${key.id}`, {
			method: "DELETE",
			apiKey: MASTER_KEY,
		});
		expect(deleteRes.status).toBe(200);

		// Key should now be rejected
		const afterDelete = await apiRequest(
			"/v1/repos/test-org/temp-repo/register",
			{
				method: "POST",
				body: {},
				apiKey: secret,
			},
		);
		expect(afterDelete.status).toBe(403);
	});

	// --------------------------------------------------------------------------
	// Usage tracking
	// --------------------------------------------------------------------------

	it("usage tracking: after using a key, list shows updated usage count", async () => {
		// Create a regular key
		const createRes = await apiRequest("/v1/keys", {
			method: "POST",
			body: { name: "usage-tracking-key" },
			apiKey: MASTER_KEY,
		});
		expect(createRes.status).toBe(201);
		const { key, secret } = await createRes.json();

		// Set up repo and data for search
		const orgSlug = "test-org";
		const repoSlug = "usage-track-repo";
		await apiRequest(`/v1/repos/${orgSlug}/${repoSlug}/register`, {
			method: "POST",
			body: {},
			apiKey: MASTER_KEY,
		});

		const commitSha = fakeSha(99);
		const chunks = Array.from({ length: 2 }, (_, i) => ({
			contentHash: fakeHash(99 + i),
			filePath: `src/track_${i}.ts`,
			startLine: 1,
			endLine: 10,
			language: "typescript",
			chunkType: "function",
			name: `tracked_fn_${i}`,
			vector: syntheticVector(99 + i),
		}));

		await apiRequest("/v1/index", {
			method: "POST",
			body: {
				orgSlug,
				repoSlug,
				commitSha,
				parentShas: [],
				chunks,
				mode: "thin",
			},
			apiKey: MASTER_KEY,
		});

		// Use the regular key for search (triggers usage tracking)
		const searchRes = await apiRequest("/v1/search", {
			method: "POST",
			body: {
				repoSlug: `${orgSlug}/${repoSlug}`,
				commitSha,
				queryText: "tracked",
				queryVector: syntheticVector(99),
				limit: 5,
			},
			apiKey: secret,
		});
		expect(searchRes.status).toBe(200);

		// Give the fire-and-forget usage write a moment to complete
		await new Promise((resolve) => setTimeout(resolve, 200));

		// List keys and verify usage count increased
		const listRes = await apiRequest("/v1/keys", { apiKey: MASTER_KEY });
		expect(listRes.status).toBe(200);
		const listBody = await listRes.json();

		const found = listBody.keys.find((k: { id: number }) => k.id === key.id);
		expect(found).toBeDefined();
		expect(found.usage.total).toBeGreaterThan(0);
		expect(found.usage.byEndpoint["POST /v1/search"]).toBeGreaterThan(0);
	});
});
