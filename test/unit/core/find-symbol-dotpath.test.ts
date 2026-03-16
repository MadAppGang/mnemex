/**
 * Unit tests for ReferenceGraphManager.findSymbol dot-path resolution.
 *
 * REGRESSION: findSymbol dot-path resolution — Fixed in /fix session dev-fix-20260316-204056-93b03bbb
 *
 * Bug: findSymbol("Tensor.realize") returned null because dot-path resolution
 * was not supported. findSymbol("realize") returned the wrong symbol (a
 * standalone function with higher PageRank beat the class method) because
 * Python methods had no parentId set.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTracker } from "../../../src/core/tracker.js";
import { ReferenceGraphManager } from "../../../src/core/reference-graph.js";
import type { SymbolDefinition } from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempTracker(): { tracker: FileTracker; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-dotpath-test-"));
	const dbPath = join(dir, "index.db");
	const tracker = new FileTracker(dbPath, dir);
	return {
		tracker,
		cleanup: () => {
			try {
				tracker.close();
			} catch {
				// best effort
			}
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		},
	};
}

const NOW = new Date().toISOString();

function makeSymbol(overrides: Partial<SymbolDefinition>): SymbolDefinition {
	return {
		id: "default-id",
		name: "default",
		kind: "function",
		filePath: "src/tensor.py",
		startLine: 1,
		endLine: 10,
		isExported: true,
		language: "python",
		pagerankScore: 0.1,
		inDegree: 0,
		outDegree: 0,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReferenceGraphManager.findSymbol — dot-path resolution", () => {
	let cleanup: () => void;

	afterEach(() => {
		if (cleanup) cleanup();
	});

	it("returns the class method when queried as 'Class.method'", () => {
		const { tracker, cleanup: c } = makeTempTracker();
		cleanup = c;

		// Insert the Tensor class
		const tensorClass = makeSymbol({
			id: "sym-tensor-class",
			name: "Tensor",
			kind: "class",
			filePath: "src/tensor.py",
			startLine: 1,
			endLine: 200,
			pagerankScore: 0.5,
		});

		// Insert the realize method (child of Tensor)
		const realizeMethod = makeSymbol({
			id: "sym-tensor-realize",
			name: "realize",
			kind: "method",
			filePath: "src/tensor.py",
			startLine: 50,
			endLine: 60,
			parentId: "sym-tensor-class",
			pagerankScore: 0.3,
		});

		// Insert a standalone function also named "realize" with higher PageRank
		// (this is the symbol that incorrectly wins when using flat name lookup)
		const standaloneRealize = makeSymbol({
			id: "sym-standalone-realize",
			name: "realize",
			kind: "function",
			filePath: "src/helpers.py",
			startLine: 1,
			endLine: 20,
			parentId: undefined,
			pagerankScore: 0.9, // higher PageRank — wins flat lookup
		});

		tracker.insertSymbols([tensorClass, realizeMethod, standaloneRealize]);

		const graph = new ReferenceGraphManager(tracker);

		// Dot-path lookup must return the method on Tensor, not the standalone fn
		const result = graph.findSymbol("Tensor.realize");
		expect(result).not.toBeNull();
		expect(result?.id).toBe("sym-tensor-realize");
		expect(result?.kind).toBe("method");
		expect(result?.parentId).toBe("sym-tensor-class");
	});

	it("returns something for flat 'realize' lookup (backward compat)", () => {
		const { tracker, cleanup: c } = makeTempTracker();
		cleanup = c;

		const tensorClass = makeSymbol({
			id: "sym-tensor-class",
			name: "Tensor",
			kind: "class",
			filePath: "src/tensor.py",
			startLine: 1,
			endLine: 200,
			pagerankScore: 0.5,
		});

		const realizeMethod = makeSymbol({
			id: "sym-tensor-realize",
			name: "realize",
			kind: "method",
			filePath: "src/tensor.py",
			startLine: 50,
			endLine: 60,
			parentId: "sym-tensor-class",
			pagerankScore: 0.3,
		});

		const standaloneRealize = makeSymbol({
			id: "sym-standalone-realize",
			name: "realize",
			kind: "function",
			filePath: "src/helpers.py",
			startLine: 1,
			endLine: 20,
			pagerankScore: 0.9,
		});

		tracker.insertSymbols([tensorClass, realizeMethod, standaloneRealize]);

		const graph = new ReferenceGraphManager(tracker);

		// Flat lookup must still return something (we don't care which one)
		const result = graph.findSymbol("realize");
		expect(result).not.toBeNull();
	});

	it("returns null for a dot-path whose class does not exist", () => {
		const { tracker, cleanup: c } = makeTempTracker();
		cleanup = c;

		const fn = makeSymbol({
			id: "sym-foo",
			name: "bar",
			kind: "function",
			filePath: "src/utils.py",
			startLine: 1,
			endLine: 5,
		});

		tracker.insertSymbols([fn]);

		const graph = new ReferenceGraphManager(tracker);

		// NonExistentClass.bar — class not in index, should return null
		const result = graph.findSymbol("NonExistentClass.bar");
		expect(result).toBeNull();
	});
});
