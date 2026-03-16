/**
 * Unit tests for ThinCloudClient
 *
 * All HTTP calls are intercepted by mocking global fetch.
 * We verify that the client constructs correct URLs, headers, bodies,
 * and handles HTTP error codes properly.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
	ThinCloudClient,
	CloudApiError,
	createThinCloudClient,
} from "../../../src/cloud/thin-client.js";
import type {
	UploadIndexRequest,
	CloudSearchRequest,
	RegisterRepoRequest,
} from "../../../src/cloud/types.js";

// ============================================================================
// Fetch mock helpers
// ============================================================================

const ENDPOINT = "https://api.mnemex.dev";
const TOKEN = "test-token-abc123";
const REPO = "acme-corp/my-repo";
const COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";

/**
 * Create a mock Response object.
 */
function mockResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	const responseHeaders = new Headers({
		"Content-Type":
			typeof body === "string" ? "text/plain" : "application/json",
		...headers,
	});
	const bodyText = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(bodyText, { status, headers: responseHeaders });
}

/** Replace global fetch with a mock that returns the given response */
function mockFetch(response: Response): ReturnType<typeof mock> {
	const fetchMock = mock(async () => response);
	// biome-ignore lint/suspicious/noExplicitAny: mock global fetch
	(globalThis as any).fetch = fetchMock;
	return fetchMock;
}

/** Replace global fetch with a mock that throws */
function mockFetchThrows(error: Error): ReturnType<typeof mock> {
	const fetchMock = mock(async () => {
		throw error;
	});
	// biome-ignore lint/suspicious/noExplicitAny: mock global fetch
	(globalThis as any).fetch = fetchMock;
	return fetchMock;
}

let client: ThinCloudClient;

beforeEach(() => {
	client = new ThinCloudClient({ endpoint: ENDPOINT, token: TOKEN });
});

// ============================================================================
// Factory function
// ============================================================================

describe("createThinCloudClient", () => {
	test("returns a ThinCloudClient instance", () => {
		const c = createThinCloudClient({ endpoint: ENDPOINT, token: TOKEN });
		expect(c).toBeInstanceOf(ThinCloudClient);
	});
});

// ============================================================================
// CloudApiError
// ============================================================================

describe("CloudApiError", () => {
	test("has correct name and properties", () => {
		const err = new CloudApiError("test error", 401, "AUTH_FAILED");
		expect(err.name).toBe("CloudApiError");
		expect(err.message).toBe("test error");
		expect(err.statusCode).toBe(401);
		expect(err.errorCode).toBe("AUTH_FAILED");
	});

	test("retryAfter is set for 429 errors", () => {
		const err = new CloudApiError("rate limited", 429, "RATE_LIMITED", 30);
		expect(err.retryAfter).toBe(30);
	});

	test("retryAfter is undefined when not provided", () => {
		const err = new CloudApiError("server error", 500, "SERVER_ERROR");
		expect(err.retryAfter).toBeUndefined();
	});
});

// ============================================================================
// Request headers
// ============================================================================

describe("ThinCloudClient — request headers", () => {
	test("includes Authorization Bearer token", async () => {
		const fetchMock = mockFetch(mockResponse({ existing: [], missing: [] }));
		await client.checkChunks(REPO, ["hash1"]);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = options.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
	});

	test("includes X-ClaudeMem-Version header (default 1)", async () => {
		const fetchMock = mockFetch(mockResponse({ existing: [], missing: [] }));
		await client.checkChunks(REPO, ["hash1"]);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = options.headers as Record<string, string>;
		expect(headers["X-ClaudeMem-Version"]).toBe("1");
	});

	test("uses custom version when specified", async () => {
		const c = new ThinCloudClient({
			endpoint: ENDPOINT,
			token: TOKEN,
			version: 2,
		});
		const fetchMock = mockFetch(mockResponse({ existing: [], missing: [] }));
		await c.checkChunks(REPO, ["hash1"]);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = options.headers as Record<string, string>;
		expect(headers["X-ClaudeMem-Version"]).toBe("2");
	});

	test("strips trailing slash from endpoint", async () => {
		const c = new ThinCloudClient({ endpoint: `${ENDPOINT}/`, token: TOKEN });
		const fetchMock = mockFetch(mockResponse({ existing: [], missing: [] }));
		await c.checkChunks(REPO, ["hash1"]);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url.startsWith(ENDPOINT)).toBe(true);
		expect(url).not.toContain("//v1");
	});
});

// ============================================================================
// checkChunks
// ============================================================================

describe("ThinCloudClient.checkChunks", () => {
	test("POSTs to /v1/chunks/check", async () => {
		const fetchMock = mockFetch(
			mockResponse({ existing: ["h1"], missing: ["h2"] }),
		);
		await client.checkChunks(REPO, ["h1", "h2"]);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ENDPOINT}/v1/chunks/check`);
		expect(options.method).toBe("POST");
	});

	test("sends repoSlug and hashes in body", async () => {
		const fetchMock = mockFetch(
			mockResponse({ existing: [], missing: ["h1"] }),
		);
		await client.checkChunks(REPO, ["h1"]);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string);
		expect(body.repoSlug).toBe(REPO);
		expect(body.hashes).toEqual(["h1"]);
	});

	test("returns parsed ChunkCheckResult", async () => {
		mockFetch(mockResponse({ existing: ["h1"], missing: ["h2"] }));
		const result = await client.checkChunks(REPO, ["h1", "h2"]);
		expect(result.existing).toEqual(["h1"]);
		expect(result.missing).toEqual(["h2"]);
	});
});

// ============================================================================
// uploadIndex
// ============================================================================

describe("ThinCloudClient.uploadIndex", () => {
	const uploadRequest: UploadIndexRequest = {
		orgSlug: "acme-corp",
		repoSlug: REPO,
		commitSha: COMMIT_SHA,
		parentShas: [],
		chunks: [
			{
				contentHash: "hash-abc",
				filePath: "src/index.ts",
				startLine: 1,
				endLine: 10,
				language: "typescript",
				chunkType: "function",
				vector: [0.1, 0.2, 0.3],
			},
		],
		mode: "thin",
	};

	test("POSTs to /v1/index", async () => {
		const fetchMock = mockFetch(
			mockResponse({
				ok: true,
				chunksAdded: 1,
				chunksDeduplicated: 0,
				status: "ready",
			}),
		);
		await client.uploadIndex(uploadRequest);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ENDPOINT}/v1/index`);
		expect(options.method).toBe("POST");
	});

	test("returns UploadIndexResponse", async () => {
		mockFetch(
			mockResponse({
				ok: true,
				chunksAdded: 1,
				chunksDeduplicated: 0,
				status: "ready",
			}),
		);
		const result = await client.uploadIndex(uploadRequest);
		expect(result.ok).toBe(true);
		expect(result.chunksAdded).toBe(1);
		expect(result.status).toBe("ready");
	});
});

// ============================================================================
// getCommitStatus
// ============================================================================

describe("ThinCloudClient.getCommitStatus", () => {
	test("GETs /v1/commits/:sha/status with repo query param", async () => {
		const fetchMock = mockFetch(
			mockResponse({ commitSha: COMMIT_SHA, status: "ready" }),
		);
		await client.getCommitStatus(REPO, COMMIT_SHA);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain(`/v1/commits/${COMMIT_SHA}/status`);
		expect(url).toContain(`repo=${encodeURIComponent(REPO)}`);
		expect(options.method).toBe("GET");
	});

	test("returns CommitStatus", async () => {
		mockFetch(
			mockResponse({
				commitSha: COMMIT_SHA,
				status: "ready",
				chunkCount: 42,
			}),
		);
		const result = await client.getCommitStatus(REPO, COMMIT_SHA);
		expect(result.commitSha).toBe(COMMIT_SHA);
		expect(result.status).toBe("ready");
		expect(result.chunkCount).toBe(42);
	});
});

// ============================================================================
// search
// ============================================================================

describe("ThinCloudClient.search", () => {
	const searchRequest: CloudSearchRequest = {
		repoSlug: REPO,
		commitSha: COMMIT_SHA,
		queryText: "authenticate user",
		limit: 5,
	};

	test("POSTs to /v1/search", async () => {
		const fetchMock = mockFetch(mockResponse([]));
		await client.search(searchRequest);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ENDPOINT}/v1/search`);
		expect(options.method).toBe("POST");
	});

	test("returns array of CloudSearchResult", async () => {
		mockFetch(
			mockResponse([
				{
					contentHash: "h1",
					filePath: "src/auth.ts",
					startLine: 10,
					endLine: 20,
					language: "typescript",
					chunkType: "function",
					score: 0.9,
				},
			]),
		);
		const results = await client.search(searchRequest);
		expect(results).toHaveLength(1);
		expect(results[0].score).toBe(0.9);
	});
});

// ============================================================================
// registerRepo
// ============================================================================

describe("ThinCloudClient.registerRepo", () => {
	const req: RegisterRepoRequest = {
		orgSlug: "acme-corp",
		repoSlug: REPO,
		displayName: "My Repo",
		mode: "thin",
	};

	test("POSTs to /v1/repos/:orgSlug/:repoSlug/register", async () => {
		const fetchMock = mockFetch(
			mockResponse({ ok: true, created: true, repoSlug: REPO }),
		);
		await client.registerRepo(req);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/repos/acme-corp/");
		expect(url).toContain("/register");
	});

	test("returns RegisterRepoResponse", async () => {
		mockFetch(mockResponse({ ok: true, created: true, repoSlug: REPO }));
		const result = await client.registerRepo(req);
		expect(result.ok).toBe(true);
		expect(result.created).toBe(true);
		expect(result.repoSlug).toBe(REPO);
	});
});

// ============================================================================
// getSymbol / getCallers / getCallees
// ============================================================================

describe("ThinCloudClient.getSymbol", () => {
	test("GETs /v1/symbol/:name with repo and commit params", async () => {
		const fetchMock = mockFetch(mockResponse([]));
		await client.getSymbol(REPO, COMMIT_SHA, "authenticateUser");
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/symbol/authenticateUser");
		expect(url).toContain(`repo=${encodeURIComponent(REPO)}`);
		expect(url).toContain(`commit=${COMMIT_SHA}`);
	});
});

describe("ThinCloudClient.getCallers", () => {
	test("GETs /v1/callers/:name with repo and commit params", async () => {
		const fetchMock = mockFetch(
			mockResponse({ symbolName: "myFn", callers: [] }),
		);
		await client.getCallers(REPO, COMMIT_SHA, "myFn");
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/callers/myFn");
	});
});

describe("ThinCloudClient.getCallees", () => {
	test("GETs /v1/callees/:name with repo and commit params", async () => {
		const fetchMock = mockFetch(
			mockResponse({ symbolName: "myFn", callees: [] }),
		);
		await client.getCallees(REPO, COMMIT_SHA, "myFn");
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/callees/myFn");
	});
});

// ============================================================================
// getMap
// ============================================================================

describe("ThinCloudClient.getMap", () => {
	test("GETs /v1/map with repo and commit params", async () => {
		const fetchMock = mockFetch(
			mockResponse("# Repo Map\n", 200, { "Content-Type": "text/plain" }),
		);
		await client.getMap(REPO, COMMIT_SHA);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/map");
		expect(url).toContain(`repo=${encodeURIComponent(REPO)}`);
		expect(url).toContain(`commit=${COMMIT_SHA}`);
	});

	test("includes query param when provided", async () => {
		const fetchMock = mockFetch(
			mockResponse("# Map\n", 200, { "Content-Type": "text/plain" }),
		);
		await client.getMap(REPO, COMMIT_SHA, "auth functions");
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("query=auth+functions");
	});

	test("includes maxTokens param when provided", async () => {
		const fetchMock = mockFetch(
			mockResponse("# Map\n", 200, { "Content-Type": "text/plain" }),
		);
		await client.getMap(REPO, COMMIT_SHA, undefined, 1000);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("maxTokens=1000");
	});

	test("returns raw text string", async () => {
		mockFetch(
			mockResponse("# Repo Map\nfile=src/index.ts\n", 200, {
				"Content-Type": "text/plain",
			}),
		);
		const result = await client.getMap(REPO, COMMIT_SHA);
		expect(result).toContain("Repo Map");
	});
});

// ============================================================================
// Error handling
// ============================================================================

describe("ThinCloudClient — error handling", () => {
	test("throws CloudApiError with statusCode 401 for auth failure", async () => {
		mockFetch(
			mockResponse({ message: "Invalid token", errorCode: "AUTH_FAILED" }, 401),
		);
		await expect(client.checkChunks(REPO, ["h1"])).rejects.toMatchObject({
			name: "CloudApiError",
			statusCode: 401,
			errorCode: "AUTH_FAILED",
		});
	});

	test("throws CloudApiError with statusCode 409 for conflict", async () => {
		mockFetch(mockResponse({ message: "Model mismatch" }, 409));
		await expect(client.checkChunks(REPO, ["h1"])).rejects.toMatchObject({
			name: "CloudApiError",
			statusCode: 409,
		});
	});

	test("throws CloudApiError with statusCode 429 for rate limit", async () => {
		mockFetch(
			mockResponse({ message: "Too many requests" }, 429, {
				"Retry-After": "60",
			}),
		);
		const error = await client.checkChunks(REPO, ["h1"]).catch((e) => e);
		expect(error).toBeInstanceOf(CloudApiError);
		expect(error.statusCode).toBe(429);
		expect(error.retryAfter).toBe(60);
	});

	test("throws CloudApiError with statusCode 500 for server error", async () => {
		mockFetch(mockResponse({ message: "Internal server error" }, 500));
		await expect(client.checkChunks(REPO, ["h1"])).rejects.toMatchObject({
			name: "CloudApiError",
			statusCode: 500,
		});
	});

	test("throws CloudApiError for non-JSON error body", async () => {
		mockFetch(new Response("Service Unavailable", { status: 503 }));
		const error = await client.checkChunks(REPO, ["h1"]).catch((e) => e);
		expect(error).toBeInstanceOf(CloudApiError);
		expect(error.statusCode).toBe(503);
	});

	test("propagates network errors (fetch throws)", async () => {
		mockFetchThrows(new Error("Network error"));
		await expect(client.checkChunks(REPO, ["h1"])).rejects.toThrow(
			"Network error",
		);
	});
});

// ============================================================================
// waitForCommit
// ============================================================================

describe("ThinCloudClient.waitForCommit", () => {
	test("returns immediately when status is ready on first poll", async () => {
		mockFetch(
			mockResponse({ commitSha: COMMIT_SHA, status: "ready", chunkCount: 5 }),
		);
		const result = await client.waitForCommit(REPO, COMMIT_SHA, 5000);
		expect(result.status).toBe("ready");
	});

	test("returns error status when server reports error on first poll", async () => {
		mockFetch(
			mockResponse({
				commitSha: COMMIT_SHA,
				status: "error",
				errorMessage: "Embedding failed",
			}),
		);
		const result = await client.waitForCommit(REPO, COMMIT_SHA, 5000);
		expect(result.status).toBe("error");
	});

	test("returns last known status when timeout is exceeded", async () => {
		// Always return pending — we should time out quickly
		const fetchMock = mock(async () =>
			mockResponse({ commitSha: COMMIT_SHA, status: "pending" }),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mock global fetch
		(globalThis as any).fetch = fetchMock;
		// Use a very short timeout to avoid slowing tests
		const result = await client.waitForCommit(REPO, COMMIT_SHA, 10);
		expect(result.status).toBe("pending");
	});
});
