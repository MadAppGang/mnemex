/**
 * Unit tests for SmartCloudClient
 *
 * Verifies that SmartCloudClient:
 *  - Sets mode to "smart" in uploadIndex requests
 *  - Sends chunk text fields instead of vector fields
 *  - Strips vector fields from chunks
 *  - Returns responses including "embedding" status
 *  - Inherits all other methods unchanged from ThinCloudClient
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
	SmartCloudClient,
	createSmartCloudClient,
} from "../../../src/cloud/smart-client.js";
import { ThinCloudClient } from "../../../src/cloud/thin-client.js";
import type { UploadIndexRequest } from "../../../src/cloud/types.js";

// ============================================================================
// Shared test constants
// ============================================================================

const ENDPOINT = "https://api.mnemex.dev";
const TOKEN = "test-token-smart";
const REPO = "acme-corp/my-repo";
const COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";

// ============================================================================
// Fetch mock helpers (mirrors thin-client.test.ts)
// ============================================================================

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

function mockFetch(response: Response): ReturnType<typeof mock> {
	const fetchMock = mock(async () => response);
	// biome-ignore lint/suspicious/noExplicitAny: mock global fetch
	(globalThis as any).fetch = fetchMock;
	return fetchMock;
}

// ============================================================================
// Fixtures
// ============================================================================

/** Upload request that a caller might build (mode and chunks filled optimistically) */
const uploadRequestWithVectors: UploadIndexRequest = {
	orgSlug: "acme-corp",
	repoSlug: REPO,
	commitSha: COMMIT_SHA,
	parentShas: [],
	mode: "thin", // caller set thin — SmartCloudClient must override to "smart"
	chunks: [
		{
			contentHash: "hash-abc",
			filePath: "src/index.ts",
			startLine: 1,
			endLine: 10,
			language: "typescript",
			chunkType: "function",
			name: "myFunction",
			vector: [0.1, 0.2, 0.3], // should be stripped by SmartCloudClient
			text: "export function myFunction() { return 42; }",
		},
		{
			contentHash: "hash-def",
			filePath: "src/util.ts",
			startLine: 5,
			endLine: 15,
			language: "typescript",
			chunkType: "function",
			name: "helperFn",
			text: "export function helperFn() {}",
			// no vector — should pass through fine
		},
	],
};

/** Typical server response for smart mode (server is still embedding) */
const embeddingResponse = {
	ok: true,
	chunksAdded: 2,
	chunksDeduplicated: 0,
	status: "pending" as const,
};

/** Server response once embedding is complete */
const readyResponse = {
	ok: true,
	chunksAdded: 0,
	chunksDeduplicated: 2,
	status: "ready" as const,
};

// ============================================================================
// Factory
// ============================================================================

describe("createSmartCloudClient", () => {
	test("returns a SmartCloudClient instance", () => {
		const c = createSmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
		expect(c).toBeInstanceOf(SmartCloudClient);
	});

	test("SmartCloudClient extends ThinCloudClient", () => {
		const c = new SmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
		expect(c).toBeInstanceOf(ThinCloudClient);
	});
});

// ============================================================================
// uploadIndex — mode override
// ============================================================================

describe("SmartCloudClient.uploadIndex — mode", () => {
	let client: SmartCloudClient;

	beforeEach(() => {
		client = new SmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
	});

	test("sets mode to 'smart' in request body regardless of caller's mode", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		expect(body.mode).toBe("smart");
	});

	test("POSTs to /v1/index", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ENDPOINT}/v1/index`);
		expect(options.method).toBe("POST");
	});
});

// ============================================================================
// uploadIndex — chunk transformation
// ============================================================================

describe("SmartCloudClient.uploadIndex — chunk transformation", () => {
	let client: SmartCloudClient;

	beforeEach(() => {
		client = new SmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
	});

	test("strips vector fields from chunks", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		for (const chunk of body.chunks) {
			expect(chunk.vector).toBeUndefined();
		}
	});

	test("preserves text fields in chunks", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		expect(body.chunks[0]?.text).toBe(
			"export function myFunction() { return 42; }",
		);
		expect(body.chunks[1]?.text).toBe("export function helperFn() {}");
	});

	test("preserves all other chunk metadata", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		const first = body.chunks[0];
		expect(first?.contentHash).toBe("hash-abc");
		expect(first?.filePath).toBe("src/index.ts");
		expect(first?.startLine).toBe(1);
		expect(first?.endLine).toBe(10);
		expect(first?.language).toBe("typescript");
		expect(first?.chunkType).toBe("function");
		expect(first?.name).toBe("myFunction");
	});

	test("handles chunks with no vector field (already absent)", async () => {
		const requestNoVectors: UploadIndexRequest = {
			...uploadRequestWithVectors,
			chunks: [
				{
					contentHash: "hash-xyz",
					filePath: "src/lib.ts",
					startLine: 1,
					endLine: 5,
					language: "typescript",
					chunkType: "function",
					text: "export const lib = () => {};",
				},
			],
		};
		const fetchMock = mockFetch(mockResponse(readyResponse));
		await client.uploadIndex(requestNoVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		expect(body.chunks).toHaveLength(1);
		expect(body.chunks[0]?.vector).toBeUndefined();
		expect(body.chunks[0]?.text).toBe("export const lib = () => {};");
	});

	test("preserves other top-level request fields unchanged", async () => {
		const fetchMock = mockFetch(mockResponse(embeddingResponse));
		await client.uploadIndex(uploadRequestWithVectors);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(options.body as string) as UploadIndexRequest;
		expect(body.orgSlug).toBe("acme-corp");
		expect(body.repoSlug).toBe(REPO);
		expect(body.commitSha).toBe(COMMIT_SHA);
		expect(body.parentShas).toEqual([]);
	});
});

// ============================================================================
// uploadIndex — response handling
// ============================================================================

describe("SmartCloudClient.uploadIndex — response", () => {
	let client: SmartCloudClient;

	beforeEach(() => {
		client = new SmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
	});

	test("returns UploadIndexResponse with 'pending' status (embedding in progress)", async () => {
		mockFetch(mockResponse(embeddingResponse));
		const result = await client.uploadIndex(uploadRequestWithVectors);
		expect(result.ok).toBe(true);
		expect(result.chunksAdded).toBe(2);
		expect(result.status).toBe("pending");
	});

	test("returns UploadIndexResponse with 'ready' status when server embeds synchronously", async () => {
		mockFetch(mockResponse(readyResponse));
		const result = await client.uploadIndex(uploadRequestWithVectors);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("ready");
	});
});

// ============================================================================
// Inherited methods (smoke tests — identical to ThinCloudClient)
// ============================================================================

describe("SmartCloudClient — inherited methods", () => {
	let client: SmartCloudClient;

	beforeEach(() => {
		client = new SmartCloudClient({ endpoint: ENDPOINT, token: TOKEN });
	});

	test("checkChunks POSTs to /v1/chunks/check", async () => {
		const fetchMock = mockFetch(
			mockResponse({ existing: ["h1"], missing: [] }),
		);
		await client.checkChunks(REPO, ["h1"]);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe(`${ENDPOINT}/v1/chunks/check`);
	});

	test("getCommitStatus GETs /v1/commits/:sha/status", async () => {
		const fetchMock = mockFetch(
			mockResponse({ commitSha: COMMIT_SHA, status: "ready" }),
		);
		await client.getCommitStatus(REPO, COMMIT_SHA);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain(`/v1/commits/${COMMIT_SHA}/status`);
	});

	test("waitForCommit returns ready status on first poll", async () => {
		mockFetch(
			mockResponse({ commitSha: COMMIT_SHA, status: "ready", chunkCount: 3 }),
		);
		const result = await client.waitForCommit(REPO, COMMIT_SHA, 5000);
		expect(result.status).toBe("ready");
	});

	test("search POSTs to /v1/search", async () => {
		const fetchMock = mockFetch(mockResponse([]));
		await client.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "test query",
		});
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe(`${ENDPOINT}/v1/search`);
	});

	test("getMap GETs /v1/map", async () => {
		const fetchMock = mockFetch(
			mockResponse("# Repo Map\n", 200, { "Content-Type": "text/plain" }),
		);
		await client.getMap(REPO, COMMIT_SHA);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toContain("/v1/map");
	});

	test("includes Authorization header on all requests", async () => {
		const fetchMock = mockFetch(mockResponse({ existing: [], missing: [] }));
		await client.checkChunks(REPO, ["h"]);
		const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = options.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
	});
});
