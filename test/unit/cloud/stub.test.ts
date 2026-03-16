/**
 * Unit tests for LocalCloudStub
 *
 * Tests validate the in-memory ICloudIndexClient implementation
 * used for testing cloud-dependent code without hitting a real API.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
	LocalCloudStub,
	createLocalCloudStub,
} from "../../../src/cloud/stub.js";
import type {
	UploadIndexRequest,
	UploadChunk,
} from "../../../src/cloud/types.js";

// ============================================================================
// Fixtures
// ============================================================================

const REPO = "acme-corp/my-repo";
const COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";
const PARENT_SHA = "parent000parent000parent000parent000par0";

function makeChunk(overrides: Partial<UploadChunk> = {}): UploadChunk {
	return {
		contentHash: "hash-" + Math.random().toString(36).slice(2),
		filePath: "src/index.ts",
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: "myFunction",
		text: "function myFunction() { return 42; }",
		...overrides,
	};
}

function makeUploadRequest(
	chunks: UploadChunk[],
	overrides: Partial<UploadIndexRequest> = {},
): UploadIndexRequest {
	return {
		orgSlug: "acme-corp",
		repoSlug: REPO,
		commitSha: COMMIT_SHA,
		parentShas: [PARENT_SHA],
		chunks,
		mode: "thin",
		...overrides,
	};
}

// ============================================================================
// Setup
// ============================================================================

let stub: LocalCloudStub;

beforeEach(() => {
	stub = new LocalCloudStub();
});

// ============================================================================
// Factory function
// ============================================================================

describe("createLocalCloudStub", () => {
	test("returns a LocalCloudStub instance", () => {
		const s = createLocalCloudStub();
		expect(s).toBeInstanceOf(LocalCloudStub);
	});
});

// ============================================================================
// registerRepo
// ============================================================================

describe("LocalCloudStub.registerRepo", () => {
	test("returns ok: true and created: true on first registration", async () => {
		const result = await stub.registerRepo({
			orgSlug: "acme-corp",
			repoSlug: REPO,
		});
		expect(result.ok).toBe(true);
		expect(result.created).toBe(true);
		expect(result.repoSlug).toBe(REPO);
	});

	test("returns created: false on subsequent registration of same repo", async () => {
		await stub.registerRepo({ orgSlug: "acme-corp", repoSlug: REPO });
		const result = await stub.registerRepo({
			orgSlug: "acme-corp",
			repoSlug: REPO,
		});
		expect(result.created).toBe(false);
	});

	test("stores the repo record", async () => {
		await stub.registerRepo({
			orgSlug: "acme-corp",
			repoSlug: REPO,
			displayName: "My Repo",
		});
		const repos = stub.getAllRepos();
		expect(repos).toHaveLength(1);
		expect(repos[0].displayName).toBe("My Repo");
	});
});

// ============================================================================
// checkChunks
// ============================================================================

describe("LocalCloudStub.checkChunks", () => {
	test("all hashes missing when no chunks uploaded", async () => {
		const result = await stub.checkChunks(REPO, ["hash1", "hash2"]);
		expect(result.existing).toEqual([]);
		expect(result.missing).toHaveLength(2);
		expect(result.missing).toContain("hash1");
		expect(result.missing).toContain("hash2");
	});

	test("uploaded hashes appear in existing", async () => {
		const chunk = makeChunk({ contentHash: "known-hash" });
		await stub.uploadIndex(makeUploadRequest([chunk]));

		const result = await stub.checkChunks(REPO, ["known-hash", "unknown-hash"]);
		expect(result.existing).toContain("known-hash");
		expect(result.missing).toContain("unknown-hash");
	});

	test("returns empty arrays for empty hash list", async () => {
		const result = await stub.checkChunks(REPO, []);
		expect(result.existing).toEqual([]);
		expect(result.missing).toEqual([]);
	});
});

// ============================================================================
// uploadIndex
// ============================================================================

describe("LocalCloudStub.uploadIndex", () => {
	test("returns ok: true with correct counts", async () => {
		const chunks = [makeChunk(), makeChunk(), makeChunk()];
		const result = await stub.uploadIndex(makeUploadRequest(chunks));
		expect(result.ok).toBe(true);
		expect(result.chunksAdded).toBe(3);
		expect(result.chunksDeduplicated).toBe(0);
		expect(result.status).toBe("ready");
	});

	test("deduplicates chunks with the same content hash", async () => {
		const chunk = makeChunk({ contentHash: "shared-hash" });
		// Upload same chunk twice in separate requests
		await stub.uploadIndex(makeUploadRequest([chunk]));
		const result = await stub.uploadIndex(
			makeUploadRequest([chunk], { commitSha: "second-commit-sha" }),
		);
		expect(result.chunksAdded).toBe(0);
		expect(result.chunksDeduplicated).toBe(1);
	});

	test("stores chunks accessible via getAllChunks()", async () => {
		const chunk = makeChunk({ contentHash: "stored-hash", name: "storedFn" });
		await stub.uploadIndex(makeUploadRequest([chunk]));
		const stored = stub.getAllChunks();
		expect(stored).toHaveLength(1);
		expect(stored[0].contentHash).toBe("stored-hash");
		expect(stored[0].name).toBe("storedFn");
	});

	test("records commit with chunk hashes", async () => {
		const chunk = makeChunk({ contentHash: "my-hash" });
		await stub.uploadIndex(makeUploadRequest([chunk]));
		const record = stub.getCommitRecord(REPO, COMMIT_SHA);
		expect(record).toBeDefined();
		expect(record!.chunkHashes.has("my-hash")).toBe(true);
	});

	test("stores deleted files in commit record", async () => {
		const chunk = makeChunk();
		await stub.uploadIndex(
			makeUploadRequest([chunk], { deletedFiles: ["src/old.ts"] }),
		);
		const record = stub.getCommitRecord(REPO, COMMIT_SHA);
		expect(record!.deletedFiles).toContain("src/old.ts");
	});
});

// ============================================================================
// getCommitStatus
// ============================================================================

describe("LocalCloudStub.getCommitStatus", () => {
	test("returns not_found for unknown commit", async () => {
		const status = await stub.getCommitStatus(REPO, "unknown-sha");
		expect(status.status).toBe("not_found");
		expect(status.commitSha).toBe("unknown-sha");
	});

	test("returns ready for uploaded commit", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk()]));
		const status = await stub.getCommitStatus(REPO, COMMIT_SHA);
		expect(status.status).toBe("ready");
		expect(status.commitSha).toBe(COMMIT_SHA);
	});

	test("includes chunkCount in ready status", async () => {
		const chunks = [makeChunk(), makeChunk()];
		await stub.uploadIndex(makeUploadRequest(chunks));
		const status = await stub.getCommitStatus(REPO, COMMIT_SHA);
		expect(status.chunkCount).toBe(2);
	});

	test("includes indexedAt in ready status", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk()]));
		const status = await stub.getCommitStatus(REPO, COMMIT_SHA);
		expect(status.indexedAt).toBeDefined();
		// Should be a valid ISO date string
		expect(() => new Date(status.indexedAt!)).not.toThrow();
	});
});

// ============================================================================
// waitForCommit
// ============================================================================

describe("LocalCloudStub.waitForCommit", () => {
	test("resolves immediately with ready status for uploaded commit", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk()]));
		const status = await stub.waitForCommit(REPO, COMMIT_SHA, 1000);
		expect(status.status).toBe("ready");
	});

	test("resolves with not_found for unknown commit", async () => {
		const status = await stub.waitForCommit(REPO, "unknown-sha", 100);
		expect(status.status).toBe("not_found");
	});
});

// ============================================================================
// search
// ============================================================================

describe("LocalCloudStub.search", () => {
	beforeEach(async () => {
		// Upload chunks for search tests
		const chunks: UploadChunk[] = [
			makeChunk({
				contentHash: "hash-auth",
				name: "authenticateUser",
				filePath: "src/auth.ts",
				language: "typescript",
				chunkType: "function",
				text: "function authenticateUser(token: string) { ... }",
			}),
			makeChunk({
				contentHash: "hash-db",
				name: "connectDatabase",
				filePath: "src/db.ts",
				language: "typescript",
				chunkType: "function",
				text: "function connectDatabase(url: string) { ... }",
			}),
			makeChunk({
				contentHash: "hash-py",
				name: "parse_config",
				filePath: "src/config.py",
				language: "python",
				chunkType: "function",
				text: "def parse_config(path): ...",
			}),
		];
		await stub.uploadIndex(makeUploadRequest(chunks));
	});

	test("returns empty array for unknown commit", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: "unknown",
			queryText: "auth",
		});
		expect(results).toEqual([]);
	});

	test("finds chunks by name match", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "authenticate",
		});
		expect(results.length).toBeGreaterThan(0);
		const names = results.map((r) => r.name);
		expect(names).toContain("authenticateUser");
	});

	test("respects limit parameter", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "function",
			limit: 1,
		});
		expect(results.length).toBeLessThanOrEqual(1);
	});

	test("filters by language", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "",
			language: "python",
		});
		expect(results.every((r) => r.language === "python")).toBe(true);
	});

	test("filters by chunkType", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "",
			chunkType: "function",
		});
		expect(results.every((r) => r.chunkType === "function")).toBe(true);
	});

	test("results are sorted by score descending", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "authenticate",
		});
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});

	test("exact name match scores higher than partial match", async () => {
		const results = await stub.search({
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			queryText: "authenticateuser",
		});
		// authenticateUser should score 1.0 for exact match (case-insensitive)
		const authResult = results.find((r) => r.name === "authenticateUser");
		expect(authResult).toBeDefined();
		expect(authResult!.score).toBe(1.0);
	});
});

// ============================================================================
// getSymbol
// ============================================================================

describe("LocalCloudStub.getSymbol", () => {
	beforeEach(async () => {
		const chunks = [
			makeChunk({
				contentHash: "h1",
				name: "getUserById",
				chunkType: "function",
			}),
			makeChunk({ contentHash: "h2", name: "getUsers", chunkType: "function" }),
			makeChunk({
				contentHash: "h3",
				name: "UserRepository",
				chunkType: "class",
			}),
		];
		await stub.uploadIndex(makeUploadRequest(chunks));
	});

	test("returns matching symbols by name substring", async () => {
		const symbols = await stub.getSymbol(REPO, COMMIT_SHA, "getUser");
		const names = symbols.map((s) => s.name);
		expect(names).toContain("getUserById");
		expect(names).toContain("getUsers");
		expect(names).not.toContain("UserRepository");
	});

	test("returns empty array for unknown commit", async () => {
		const symbols = await stub.getSymbol(REPO, "unknown", "getUser");
		expect(symbols).toEqual([]);
	});

	test("includes symbol metadata", async () => {
		const symbols = await stub.getSymbol(REPO, COMMIT_SHA, "getUserById");
		expect(symbols).toHaveLength(1);
		expect(symbols[0].kind).toBe("function");
		expect(symbols[0].filePath).toBeDefined();
		expect(symbols[0].startLine).toBeGreaterThan(0);
	});
});

// ============================================================================
// getCallers / getCallees
// ============================================================================

describe("LocalCloudStub.getCallers", () => {
	test("returns empty callers list (symbol graph not tracked in stub)", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk({ name: "myFn" })]));
		const result = await stub.getCallers(REPO, COMMIT_SHA, "myFn");
		expect(result.symbolName).toBe("myFn");
		expect(result.callers).toEqual([]);
	});
});

describe("LocalCloudStub.getCallees", () => {
	test("returns empty callees list (symbol graph not tracked in stub)", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk({ name: "myFn" })]));
		const result = await stub.getCallees(REPO, COMMIT_SHA, "myFn");
		expect(result.symbolName).toBe("myFn");
		expect(result.callees).toEqual([]);
	});
});

// ============================================================================
// getMap
// ============================================================================

describe("LocalCloudStub.getMap", () => {
	test("returns 'no index' message for unknown commit", async () => {
		const map = await stub.getMap(REPO, "unknown-sha");
		expect(map).toContain("No index found");
	});

	test("returns map header with repo and sha", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk({ name: "myFn" })]));
		const map = await stub.getMap(REPO, COMMIT_SHA);
		expect(map).toContain("Repo Map");
		expect(map).toContain(COMMIT_SHA.slice(0, 8));
	});

	test("includes query in map when provided", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk({ name: "myFn" })]));
		const map = await stub.getMap(REPO, COMMIT_SHA, "auth functions");
		expect(map).toContain("auth functions");
	});

	test("lists symbols for uploaded chunks", async () => {
		await stub.uploadIndex(
			makeUploadRequest([
				makeChunk({
					contentHash: "h1",
					name: "myFunction",
					filePath: "src/a.ts",
				}),
			]),
		);
		const map = await stub.getMap(REPO, COMMIT_SHA);
		expect(map).toContain("myFunction");
		expect(map).toContain("src/a.ts");
	});
});

// ============================================================================
// reset
// ============================================================================

describe("LocalCloudStub.reset", () => {
	test("clears all stored data", async () => {
		await stub.registerRepo({ orgSlug: "acme-corp", repoSlug: REPO });
		await stub.uploadIndex(makeUploadRequest([makeChunk()]));

		stub.reset();

		expect(stub.getAllChunks()).toHaveLength(0);
		expect(stub.getAllRepos()).toHaveLength(0);
		expect(stub.getCommitRecord(REPO, COMMIT_SHA)).toBeUndefined();
	});
});
