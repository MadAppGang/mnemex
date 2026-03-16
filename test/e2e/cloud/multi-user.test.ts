/**
 * E2E tests for multi-user scenarios.
 *
 * Covers four scenarios:
 *   1. Branch isolation — commits on parallel branches do not leak data
 *   2. Local dirty + cloud clean — overlay takes precedence for dirty files
 *   3. Incremental commits — child inherits parent's chunks
 *   4. Concurrent indexing — two simultaneous uploads both resolve correctly
 *
 * Port: 4515 (distinct from thin-mode.test.ts at 4512)
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { createThinCloudClient } from "../../../src/cloud/thin-client.js";
import { createCloudAwareSearch } from "../../../src/cloud/search.js";
import type { SearchResult } from "../../../src/types.js";
import { TEST_ORG_SLUG, type TestContext, startTestInfra } from "./setup.js";
import { TraceCollector } from "./helpers/trace-collector.js";
import { MockChangeDetector } from "./helpers/mock-change-detector.js";
import { MockEmbeddingsClient } from "./helpers/mock-embeddings.js";
import { MockOverlayIndex } from "./helpers/mock-overlay-index.js";
import {
	registerAndIndex,
	makeChunks,
	fakeSha,
	fakeHash,
	syntheticVector,
	cloudToMerged,
	REPO_SLUG,
	ORG_SLUG,
	BARE_REPO_SLUG,
} from "./helpers/multi-user-factory.js";

// ============================================================================
// Test suite
// ============================================================================

describe("E2E: Multi-user scenarios", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await startTestInfra(4515);
	}, 30_000);

	afterAll(async () => {
		await ctx.stop();
	});

	beforeEach(async () => {
		await ctx.resetDb();
	});

	// Helper: create a client pointing at the test server
	function createClient() {
		return createThinCloudClient({ endpoint: ctx.endpoint, token: "dummy" });
	}

	// ==========================================================================
	// Scenario 1: Branch isolation
	// ==========================================================================

	describe("Scenario 1: Branch isolation", () => {
		it("searches at different commit SHAs return only files from that commit", async () => {
			// SHA range: 100–109
			const SHA_MAIN = fakeSha(100);
			const SHA_FEATURE = fakeSha(101);

			const mainFileNames = [
				"src/main_branch_file_0.ts",
				"src/main_branch_file_1.ts",
				"src/main_branch_file_2.ts",
			];
			const featureFileNames = [
				"src/feature_branch_file_0.ts",
				"src/feature_branch_file_1.ts",
				"src/feature_branch_file_2.ts",
			];

			const mainChunks = makeChunks(3, 100, mainFileNames);
			const featureChunks = makeChunks(3, 103, featureFileNames);

			// Register once (shared repo), then upload both commits
			const clientA = createClient();
			await clientA.registerRepo({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
			});

			const uploadMain = await clientA.uploadIndex({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
				commitSha: SHA_MAIN,
				parentShas: [],
				chunks: mainChunks,
				mode: "thin",
			});
			expect(uploadMain.ok).toBe(true);
			expect(uploadMain.status).toBe("ready");

			const clientB = createClient();
			const uploadFeature = await clientB.uploadIndex({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
				commitSha: SHA_FEATURE,
				parentShas: [],
				chunks: featureChunks,
				mode: "thin",
			});
			expect(uploadFeature.ok).toBe(true);
			expect(uploadFeature.status).toBe("ready");

			// ── Search at SHA_MAIN ──────────────────────────────────────────
			const traceMain = new TraceCollector();
			const mainResults = await clientA.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_MAIN,
				queryText: "main branch",
				queryVector: syntheticVector(100),
				limit: 10,
			});
			traceMain.record(cloudToMerged(mainResults));

			const { summary: mainSummary, byFile: mainByFile } = traceMain;
			expect(mainSummary.total).toBeGreaterThan(0);
			expect(mainSummary.cloudCount).toBe(mainSummary.total);

			const mainFilePaths = mainResults.map((r) => r.filePath);
			// All results should be main-branch files
			for (const fp of mainFilePaths) {
				expect(fp).toMatch(/main_branch_file/);
			}
			// No feature-branch files should appear
			expect(mainFilePaths.some((p) => p.includes("feature_branch"))).toBe(
				false,
			);

			for (const [fp, source] of mainByFile) {
				expect(fp).toMatch(/main_branch_file/);
				expect(source).toBe("cloud");
			}

			// ── Search at SHA_FEATURE ───────────────────────────────────────
			const traceFeature = new TraceCollector();
			const featureResults = await clientB.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_FEATURE,
				queryText: "feature branch",
				queryVector: syntheticVector(103),
				limit: 10,
			});
			traceFeature.record(cloudToMerged(featureResults));

			const { summary: featureSummary, byFile: featureByFile } = traceFeature;
			expect(featureSummary.total).toBeGreaterThan(0);
			expect(featureSummary.cloudCount).toBe(featureSummary.total);

			const featureFilePaths = featureResults.map((r) => r.filePath);
			for (const fp of featureFilePaths) {
				expect(fp).toMatch(/feature_branch_file/);
			}
			// No main-branch files should appear
			expect(featureFilePaths.some((p) => p.includes("main_branch"))).toBe(
				false,
			);

			for (const [fp, source] of featureByFile) {
				expect(fp).toMatch(/feature_branch_file/);
				expect(source).toBe("cloud");
			}

			// ── Cross-check: clientA searching at SHA_FEATURE ─────────────
			// Server isolates by commit SHA, not by client identity
			const crossResults = await clientA.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_FEATURE,
				queryText: "feature",
				queryVector: syntheticVector(103),
				limit: 10,
			});
			const crossFilePaths = crossResults.map((r) => r.filePath);
			// Should see feature files, not main files
			expect(crossFilePaths.some((p) => p.includes("main_branch"))).toBe(false);
		});
	});

	// ==========================================================================
	// Scenario 2: Local dirty + cloud clean
	// ==========================================================================

	describe("Scenario 2: Local dirty files + cloud clean files", () => {
		it("dirty files come from overlay, clean files come from cloud", async () => {
			// SHA range: 200–209
			const SHA_CLOUD = fakeSha(200);

			const FILE_A = "src/file_a.ts";
			const FILE_B = "src/file_b.ts";
			const FILE_C = "src/file_c.ts";

			// Upload 3 cloud chunks (one per file)
			const cloudChunks = [
				{
					contentHash: fakeHash(200),
					filePath: FILE_A,
					startLine: 1,
					endLine: 10,
					language: "typescript",
					chunkType: "function",
					name: "fnA",
					vector: syntheticVector(200),
				},
				{
					contentHash: fakeHash(201),
					filePath: FILE_B,
					startLine: 1,
					endLine: 10,
					language: "typescript",
					chunkType: "function",
					name: "fnB",
					vector: syntheticVector(201),
				},
				{
					contentHash: fakeHash(202),
					filePath: FILE_C,
					startLine: 1,
					endLine: 10,
					language: "typescript",
					chunkType: "function",
					name: "fnC",
					vector: syntheticVector(202),
				},
			];

			const client = createClient();
			await client.registerRepo({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
			});

			const uploadResult = await client.uploadIndex({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
				commitSha: SHA_CLOUD,
				parentShas: [],
				chunks: cloudChunks,
				mode: "thin",
			});
			expect(uploadResult.ok).toBe(true);
			expect(uploadResult.status).toBe("ready");

			// ── Build mocks for the overlay scenario ────────────────────────
			const dirtyB = { filePath: FILE_B, status: "modified" as const };

			// The overlay result for the locally-modified file_b.ts
			const overlayResultB: SearchResult = {
				chunk: {
					id: "overlay-b-chunk",
					contentHash: "overlay-b-hash",
					content: "export function fnBModified() {}",
					filePath: FILE_B,
					startLine: 1,
					endLine: 12,
					language: "typescript",
					chunkType: "function",
					name: "fnBModified",
					fileHash: "overlay-file-hash",
				},
				score: 0.9,
				vectorScore: 0.9,
				keywordScore: 0,
			};

			const mockChangeDetector = new MockChangeDetector({
				headSha: SHA_CLOUD,
				dirtyFiles: [dirtyB],
			});
			const mockOverlayIndex = new MockOverlayIndex();
			mockOverlayIndex.setResults([overlayResultB]);
			const mockEmbeddingsClient = new MockEmbeddingsClient();

			// ── Build CloudAwareSearch ────────────────────────────────────────
			const cloudAwareSearch = createCloudAwareSearch({
				projectPath: "/tmp/fake-project",
				cloudClient: createThinCloudClient({
					endpoint: ctx.endpoint,
					token: "dummy",
				}),
				overlayIndex: mockOverlayIndex,
				changeDetector: mockChangeDetector,
				embeddingsClient: mockEmbeddingsClient,
				repoSlug: REPO_SLUG,
				commitSha: SHA_CLOUD,
			});

			const mergedResults = await cloudAwareSearch.search("function", {
				limit: 10,
			});

			// ── TraceCollector assertions ────────────────────────────────────
			const trace = new TraceCollector();
			trace.record(mergedResults);

			const { summary } = trace;
			expect(summary.total).toBeGreaterThanOrEqual(3);
			expect(summary.cloudCount).toBeGreaterThanOrEqual(2);
			expect(summary.overlayCount).toBeGreaterThanOrEqual(1);

			// file_b must come from overlay (not cloud)
			expect(trace.getSourceForFile(FILE_B)).toBe("overlay");
			// file_a and file_c must come from cloud
			expect(trace.getSourceForFile(FILE_A)).toBe("cloud");
			expect(trace.getSourceForFile(FILE_C)).toBe("cloud");
		});
	});

	// ==========================================================================
	// Scenario 3: Incremental commit inheritance
	// ==========================================================================

	describe("Scenario 3: Incremental commit inheritance", () => {
		it("child commit inherits parent files and new file is searchable", async () => {
			// SHA range: 300–309
			const SHA_PARENT = fakeSha(300);
			const SHA_CHILD = fakeSha(301);

			const parentFileNames = [
				"src/parent_file_0.ts",
				"src/parent_file_1.ts",
				"src/parent_file_2.ts",
			];
			const newFileName = "src/new_commit_file.ts";

			// Index parent commit with 3 files
			const parentResult = await registerAndIndex(
				ctx.endpoint,
				SHA_PARENT,
				[],
				makeChunks(3, 300, parentFileNames),
			);
			expect(parentResult.ok).toBe(true);
			expect(parentResult.status).toBe("ready");

			// Index child commit with 1 new file, inheriting from parent
			const childResult = await registerAndIndex(
				ctx.endpoint,
				SHA_CHILD,
				[SHA_PARENT],
				makeChunks(1, 310, [newFileName]),
			);
			expect(childResult.ok).toBe(true);
			expect(childResult.status).toBe("ready");

			const client = createClient();

			// ── Search at SHA_CHILD ─────────────────────────────────────────
			const childResults = await client.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_CHILD,
				queryText: "new commit file",
				queryVector: syntheticVector(310),
				limit: 10,
			});

			const traceChild = new TraceCollector();
			traceChild.record(cloudToMerged(childResults));

			expect(traceChild.summary.total).toBeGreaterThan(0);
			expect(traceChild.summary.cloudCount).toBeGreaterThan(0);

			// The new file should be present at the child commit
			const childFilePaths = childResults.map((r) => r.filePath);
			expect(childFilePaths.some((p) => p.includes("new_commit_file"))).toBe(
				true,
			);

			// ── Verify parent commit is still searchable ────────────────────
			const parentResults = await client.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_PARENT,
				queryText: "parent file",
				queryVector: syntheticVector(300),
				limit: 10,
			});

			const traceParent = new TraceCollector();
			traceParent.record(cloudToMerged(parentResults));

			expect(traceParent.summary.total).toBeGreaterThan(0);
			expect(traceParent.summary.cloudCount).toBeGreaterThan(0);

			// Parent commit results should only contain parent files
			const parentFilePaths = parentResults.map((r) => r.filePath);
			expect(parentFilePaths.some((p) => p.includes("new_commit_file"))).toBe(
				false,
			);
		});
	});

	// ==========================================================================
	// Scenario 4: Concurrent indexing
	// ==========================================================================

	describe("Scenario 4: Concurrent indexing", () => {
		it("two simultaneous uploads both resolve to ready with no cross-contamination", async () => {
			// SHA range: 400–409
			const SHA_A = fakeSha(400);
			const SHA_B = fakeSha(401);

			const fileNamesA = [
				"src/user_a_file_0.ts",
				"src/user_a_file_1.ts",
				"src/user_a_file_2.ts",
			];
			const fileNamesB = [
				"src/user_b_file_0.ts",
				"src/user_b_file_1.ts",
				"src/user_b_file_2.ts",
			];

			const chunksA = makeChunks(3, 400, fileNamesA);
			const chunksB = makeChunks(3, 403, fileNamesB);

			// Register once, then fire both uploads concurrently
			const clientA = createClient();
			const clientB = createClient();
			await clientA.registerRepo({
				orgSlug: ORG_SLUG,
				repoSlug: BARE_REPO_SLUG,
			});

			const [resultA, resultB] = await Promise.all([
				clientA.uploadIndex({
					orgSlug: ORG_SLUG,
					repoSlug: BARE_REPO_SLUG,
					commitSha: SHA_A,
					parentShas: [],
					chunks: chunksA,
					mode: "thin",
				}),
				clientB.uploadIndex({
					orgSlug: ORG_SLUG,
					repoSlug: BARE_REPO_SLUG,
					commitSha: SHA_B,
					parentShas: [],
					chunks: chunksB,
					mode: "thin",
				}),
			]);

			// Both uploads must have succeeded
			expect(resultA.ok).toBe(true);
			expect(resultA.status).toBe("ready");
			expect(resultB.ok).toBe(true);
			expect(resultB.status).toBe("ready");

			// ── Search at SHA_A ─────────────────────────────────────────────
			const searchA = await clientA.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_A,
				queryText: "user a",
				queryVector: syntheticVector(400),
				limit: 10,
			});

			const traceA = new TraceCollector();
			traceA.record(cloudToMerged(searchA));

			expect(traceA.summary.total).toBeGreaterThan(0);
			expect(traceA.summary.cloudCount).toBe(traceA.summary.total);

			const filePathsA = searchA.map((r) => r.filePath);
			for (const fp of filePathsA) {
				expect(fp).toMatch(/user_a_file/);
			}
			// No cross-contamination from user B
			expect(filePathsA.some((p) => p.includes("user_b_file"))).toBe(false);

			// ── Search at SHA_B ─────────────────────────────────────────────
			const searchB = await clientB.search({
				repoSlug: REPO_SLUG,
				commitSha: SHA_B,
				queryText: "user b",
				queryVector: syntheticVector(403),
				limit: 10,
			});

			const traceB = new TraceCollector();
			traceB.record(cloudToMerged(searchB));

			expect(traceB.summary.total).toBeGreaterThan(0);
			expect(traceB.summary.cloudCount).toBe(traceB.summary.total);

			const filePathsB = searchB.map((r) => r.filePath);
			for (const fp of filePathsB) {
				expect(fp).toMatch(/user_b_file/);
			}
			// No cross-contamination from user A
			expect(filePathsB.some((p) => p.includes("user_a_file"))).toBe(false);
		});
	});
});
