/**
 * Tests for commit-driven memory invalidation.
 *
 * The storage (commits table, provenance columns) is pinned by
 * tracker-commit-provenance.test.ts. What is pinned here is the DECISION:
 * which stored memories a commit is allowed to conclude something about.
 *
 * The load-bearing rules, in the order they can do damage if broken:
 *   1. An OBSERVED document is never destroyed by a source change. It cannot be
 *      re-derived, so a wrong flag is recoverable and a wrong delete is not.
 *   2. An EXTERNAL document is never touched by a repo commit at all. This repo
 *      commits nothing about React's documentation.
 *   3. NULL provenance reads as VALID. Every index written before this existed
 *      is NULL everywhere; the other reading hides the whole index.
 *   4. Nothing is deleted, ever, and a large diff does not become one statement
 *      per document.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/** Every row this file writes and reads lives on one branch. */
const BRANCH = 0;

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ALL_DOCUMENT_TYPES,
	classifyDocumentType,
	DERIVED_DOCUMENT_TYPES,
	DOCUMENT_CLASS,
	EXTERNAL_DOCUMENT_TYPES,
	getStalenessReport,
	invalidateForChangedFiles,
	invalidateForCommit,
	OBSERVED_DOCUMENT_TYPES,
} from "../../../src/core/invalidation.js";
import { FileTracker } from "../../../src/core/tracker.js";
import { runPostCommitInvalidation } from "../../../src/git/hook-manager.js";
import type { DocumentType } from "../../../src/types.js";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "mnemex-invalidation-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function newTracker(): FileTracker {
	return new FileTracker(join(workDir, "index.db"), workDir);
}

function addDocument(
	tracker: FileTracker,
	id: string,
	documentType: DocumentType,
	filePath: string,
): void {
	tracker.trackDocument(BRANCH, {
		id,
		documentType,
		filePath,
		sourceIds: [],
		createdAt: new Date().toISOString(),
	});
}

function documentCount(tracker: FileTracker): number {
	const row = tracker
		.getDatabase()
		.prepare("SELECT COUNT(*) as count FROM documents")
		.get() as { count: number };
	return row.count;
}

/**
 * Record every SQL string the tracker prepares while `fn` runs.
 *
 * `createDatabaseSync` returns a plain object, so replacing `prepare` on the
 * instance the tracker holds intercepts every statement it issues without
 * touching production code.
 */
function recordSql<T>(tracker: FileTracker, fn: () => T): [T, string[]] {
	const db = tracker.getDatabase();
	const original = db.prepare.bind(db);
	const seen: string[] = [];

	db.prepare = (sql: string) => {
		seen.push(sql);
		return original(sql);
	};

	try {
		return [fn(), seen];
	} finally {
		db.prepare = original;
	}
}

const SHA = "a".repeat(40);
const EXTERNAL_TYPES = ["framework_doc", "best_practice", "api_reference"];

// ============================================================================
// Taxonomy
// ============================================================================

describe("document classification", () => {
	/**
	 * Compile-time exhaustiveness.
	 *
	 * `DOCUMENT_CLASS` is typed `Record<DocumentType, DocumentClass>`, so a new
	 * member of `DocumentType` without an entry is already a compile error at the
	 * definition. This asserts the same thing from the consuming side: if the
	 * Exclude is ever non-never, `AssertNever` fails to instantiate and
	 * `bun run typecheck` breaks. That is the point — the next document type must
	 * not be able to silently inherit somebody else's policy.
	 */
	type AssertNever<T extends never> = T;
	type _EveryTypeIsClassified = AssertNever<
		Exclude<DocumentType, keyof typeof DOCUMENT_CLASS>
	>;

	/** The full union, written out, so an ADDED type also fails compilation here */
	const EVERY_DOCUMENT_TYPE = [
		"code_chunk",
		"file_summary",
		"symbol_summary",
		"idiom",
		"usage_example",
		"anti_pattern",
		"project_doc",
		"framework_doc",
		"best_practice",
		"api_reference",
		"session_observation",
	] as const satisfies readonly DocumentType[];

	type _NoTypeMissingFromLiteralList = AssertNever<
		Exclude<DocumentType, (typeof EVERY_DOCUMENT_TYPE)[number]>
	>;

	test("every DocumentType has exactly one class, with no extras", () => {
		// Runtime mirror of the compile-time check: catches a key that is present
		// in the map but not in the union (a typo'd entry classifying nothing).
		expect([...Object.keys(DOCUMENT_CLASS)].sort()).toEqual(
			[...EVERY_DOCUMENT_TYPE].sort(),
		);

		for (const type of EVERY_DOCUMENT_TYPE) {
			expect(["derived", "observed", "external"]).toContain(
				DOCUMENT_CLASS[type],
			);
		}

		// The three buckets partition the union — no gaps, no overlaps.
		expect(
			DERIVED_DOCUMENT_TYPES.length +
				OBSERVED_DOCUMENT_TYPES.length +
				EXTERNAL_DOCUMENT_TYPES.length,
		).toBe(ALL_DOCUMENT_TYPES.length);
		expect(ALL_DOCUMENT_TYPES.length).toBe(EVERY_DOCUMENT_TYPE.length);
	});

	test("classes match the policy each type actually needs", () => {
		// Re-derivable from repo source.
		for (const type of [
			"code_chunk",
			"file_summary",
			"symbol_summary",
			"idiom",
			"usage_example",
			"anti_pattern",
		] as const) {
			expect(classifyDocumentType(type)).toBe("derived");
		}

		// Not re-derivable — losing one is unrecoverable.
		for (const type of ["session_observation", "project_doc"] as const) {
			expect(classifyDocumentType(type)).toBe("observed");
		}

		// Upstream docs — a repo commit says nothing about them.
		for (const type of [
			"framework_doc",
			"best_practice",
			"api_reference",
		] as const) {
			expect(classifyDocumentType(type)).toBe("external");
		}
	});

	test("an unrecognised type is treated as observed, the conservative side", () => {
		// Worst case is a needless flag, never the destruction of a document whose
		// provenance we failed to understand.
		expect(classifyDocumentType("some_future_type")).toBe("observed");
	});
});

// ============================================================================
// Invalidation policy
// ============================================================================

describe("derived documents", () => {
	test("a changed source file supersedes them and queues re-enrichment", () => {
		const tracker = newTracker();

		const filePath = "src/a.ts";
		tracker.markIndexed(0, join(workDir, filePath), "hash-a", ["c1"]);
		tracker.setEnrichmentState(
			BRANCH,
			join(workDir, filePath),
			"file_summary",
			"complete",
		);
		tracker.setEnrichmentState(
			BRANCH,
			join(workDir, filePath),
			"symbol_summary",
			"complete",
		);
		addDocument(tracker, "derived-1", "file_summary", filePath);

		expect(tracker.getDocumentProvenance(BRANCH, "derived-1")?.isValid).toBe(
			true,
		);

		const counts = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: [filePath],
			commitSha: SHA,
		});

		expect(counts.derivedInvalidated).toBe(1);
		expect(counts.filesQueuedForReEnrichment).toBe(1);

		const provenance = tracker.getDocumentProvenance(BRANCH, "derived-1");
		expect(provenance?.invalidatedAtCommit).toBe(SHA);
		expect(provenance?.isValid).toBe(false);
		// Superseded, not flagged: the two states are independent.
		expect(provenance?.isStale).toBe(false);

		// Queued for re-derivation.
		expect(
			tracker.needsEnrichment(BRANCH, join(workDir, filePath), "file_summary"),
		).toBe(true);
		expect(tracker.getFilesNeedingEnrichment(BRANCH, "file_summary")).toContain(
			filePath,
		);

		tracker.close();
	});

	test("an untouched file's documents stay valid", () => {
		const tracker = newTracker();

		addDocument(tracker, "changed", "file_summary", "src/a.ts");
		addDocument(tracker, "untouched", "file_summary", "src/b.ts");

		invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});

		expect(tracker.getDocumentProvenance(BRANCH, "changed")?.isValid).toBe(
			false,
		);
		expect(tracker.getDocumentProvenance(BRANCH, "untouched")?.isValid).toBe(
			true,
		);

		tracker.close();
	});

	test("the first invalidating commit is kept, not the most recent", () => {
		const tracker = newTracker();
		addDocument(tracker, "derived-1", "file_summary", "src/a.ts");

		invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});
		const second = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: "b".repeat(40),
		});

		// "When did this stop being true" is the useful question, not "when did we
		// last notice".
		expect(second.derivedInvalidated).toBe(0);
		expect(
			tracker.getDocumentProvenance(BRANCH, "derived-1")?.invalidatedAtCommit,
		).toBe(SHA);

		tracker.close();
	});

	test("documents stored under an absolute path are matched too", () => {
		const tracker = newTracker();
		// Nothing in the schema forces the relative spelling; the diff is relative.
		addDocument(tracker, "abs-1", "file_summary", join(workDir, "src/a.ts"));

		const counts = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});

		expect(counts.derivedInvalidated).toBe(1);
		expect(tracker.getDocumentProvenance(BRANCH, "abs-1")?.isValid).toBe(false);

		tracker.close();
	});
});

describe("observed documents", () => {
	test("a changed source file flags them stale but never invalidates them", () => {
		const tracker = newTracker();

		addDocument(tracker, "obs-1", "session_observation", "src/a.ts");
		addDocument(tracker, "obs-2", "project_doc", "src/a.ts");
		const before = documentCount(tracker);

		const counts = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});

		expect(counts.observedFlaggedStale).toBe(2);
		expect(counts.derivedInvalidated).toBe(0);

		for (const id of ["obs-1", "obs-2"]) {
			const provenance = tracker.getDocumentProvenance(BRANCH, id);
			expect(provenance).not.toBeNull();
			expect(provenance?.staleAtCommit).toBe(SHA);
			expect(provenance?.isStale).toBe(true);
			// The whole point: still valid, still returned, just no longer trusted
			// blindly. An observation cannot be regenerated by any pipeline.
			expect(provenance?.invalidatedAtCommit).toBeNull();
			expect(provenance?.isValid).toBe(true);
		}

		// The rows are still there.
		expect(documentCount(tracker)).toBe(before);
		expect(
			tracker.getDocumentsForFile(BRANCH, join(workDir, "src/a.ts")),
		).toHaveLength(2);

		tracker.close();
	});

	test("re-flagging keeps the first flagging commit and can be acknowledged", () => {
		const tracker = newTracker();
		addDocument(tracker, "obs-1", "session_observation", "src/a.ts");

		invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});
		const second = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: "b".repeat(40),
		});
		expect(second.observedFlaggedStale).toBe(0);
		expect(tracker.getDocumentProvenance(BRANCH, "obs-1")?.staleAtCommit).toBe(
			SHA,
		);

		// A flag nobody can clear is a flag everybody learns to ignore.
		expect(tracker.clearDocumentsStale(BRANCH, ["obs-1"])).toBe(1);
		expect(tracker.getDocumentProvenance(BRANCH, "obs-1")?.isStale).toBe(false);
		expect(documentCount(tracker)).toBe(1);

		tracker.close();
	});
});

describe("external documents", () => {
	test("a commit that changes their file leaves them completely untouched", () => {
		const tracker = newTracker();

		for (const [id, type] of [
			["ext-1", "framework_doc"],
			["ext-2", "best_practice"],
			["ext-3", "api_reference"],
		] as const) {
			addDocument(tracker, id, type, "src/a.ts");
		}

		const counts = invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});

		// Counted so the exemption is visible, written to never.
		expect(counts.externalSkipped).toBe(3);
		expect(counts.derivedInvalidated).toBe(0);
		expect(counts.observedFlaggedStale).toBe(0);

		for (const id of ["ext-1", "ext-2", "ext-3"]) {
			const provenance = tracker.getDocumentProvenance(BRANCH, id);
			// Upstream documentation did not change because this repo committed.
			expect(provenance?.invalidatedAtCommit).toBeNull();
			expect(provenance?.staleAtCommit).toBeNull();
			expect(provenance?.isValid).toBe(true);
			expect(provenance?.isStale).toBe(false);
		}

		tracker.close();
	});

	test("no UPDATE targeting external types is even issued", () => {
		const tracker = newTracker();
		addDocument(tracker, "ext-1", "framework_doc", "src/a.ts");

		const [, sql] = recordSql(tracker, () =>
			invalidateForChangedFiles(tracker, BRANCH, {
				changedPaths: ["src/a.ts"],
				commitSha: SHA,
			}),
		);

		const writes = sql.filter((s) => /^\s*UPDATE/i.test(s));
		for (const statement of writes) {
			for (const type of EXTERNAL_TYPES) {
				expect(statement).not.toContain(type);
			}
		}

		tracker.close();
	});
});

// ============================================================================
// Safety rails
// ============================================================================

describe("safety rails", () => {
	test("pre-existing rows with NULL provenance read as VALID", () => {
		const tracker = newTracker();

		// Simulate a row written before provenance existed: no commit stamped.
		tracker.setCurrentCommit(null);
		addDocument(tracker, "legacy-1", "file_summary", "src/legacy.ts");

		const provenance = tracker.getDocumentProvenance(BRANCH, "legacy-1");
		expect(provenance?.validFromCommit).toBeNull();
		expect(provenance?.invalidatedAtCommit).toBeNull();
		expect(provenance?.staleAtCommit).toBeNull();
		// If unknown provenance read as invalid, every index predating this
		// feature would silently return nothing at all.
		expect(provenance?.isValid).toBe(true);

		// And an invalidation pass over unrelated files must not change that.
		invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/other.ts"],
			commitSha: SHA,
		});
		expect(tracker.getDocumentProvenance(BRANCH, "legacy-1")?.isValid).toBe(
			true,
		);

		// The report agrees: nothing is invalidated or stale.
		const report = getStalenessReport(tracker, BRANCH);
		expect(report.totals.total).toBe(1);
		expect(report.totals.invalidated).toBe(0);
		expect(report.totals.stale).toBe(0);

		tracker.close();
	});

	test("invalidation conserves every row and issues no DELETE", () => {
		const tracker = newTracker();

		addDocument(tracker, "d-1", "file_summary", "src/a.ts");
		addDocument(tracker, "d-2", "symbol_summary", "src/a.ts");
		addDocument(tracker, "o-1", "session_observation", "src/a.ts");
		addDocument(tracker, "e-1", "framework_doc", "src/a.ts");

		const before = documentCount(tracker);
		expect(before).toBe(4);

		const [, sql] = recordSql(tracker, () =>
			invalidateForChangedFiles(tracker, BRANCH, {
				changedPaths: ["src/a.ts"],
				commitSha: SHA,
			}),
		);

		// Facts are superseded, never deleted.
		expect(sql.some((s) => /\bDELETE\b/i.test(s))).toBe(false);
		expect(documentCount(tracker)).toBe(before);

		// Every id still resolves.
		for (const id of ["d-1", "d-2", "o-1", "e-1"]) {
			expect(tracker.getDocumentProvenance(BRANCH, id)).not.toBeNull();
		}

		tracker.close();
	});

	test("N documents do not become N statements", () => {
		const tracker = newTracker();

		const paths: string[] = [];
		for (let i = 0; i < 250; i++) {
			const filePath = `src/file-${i}.ts`;
			paths.push(filePath);
			addDocument(tracker, `derived-${i}`, "file_summary", filePath);
			addDocument(tracker, `observed-${i}`, "session_observation", filePath);
		}

		const [counts, sql] = recordSql(tracker, () =>
			invalidateForChangedFiles(tracker, BRANCH, {
				changedPaths: paths,
				commitSha: SHA,
			}),
		);

		expect(counts.derivedInvalidated).toBe(250);
		expect(counts.observedFlaggedStale).toBe(250);

		// 250 paths expand to 500 bound path variants, batched at 400 per
		// statement: 2 statements per operation, 4 operations. The assertion that
		// matters is the shape — statements scale with batches, not documents.
		const statements = sql.filter((s) => /^\s*(UPDATE|SELECT)/i.test(s));
		expect(statements.length).toBeLessThan(20);
		expect(statements.length).toBeLessThan(paths.length);

		tracker.close();
	});

	test("an empty diff writes nothing", () => {
		const tracker = newTracker();
		addDocument(tracker, "d-1", "file_summary", "src/a.ts");

		const [counts, sql] = recordSql(tracker, () =>
			invalidateForChangedFiles(tracker, BRANCH, {
				changedPaths: [],
				commitSha: SHA,
			}),
		);

		expect(counts.derivedInvalidated).toBe(0);
		expect(sql.some((s) => /^\s*UPDATE/i.test(s))).toBe(false);
		expect(tracker.getDocumentProvenance(BRANCH, "d-1")?.isValid).toBe(true);

		tracker.close();
	});
});

// ============================================================================
// Git degradation
// ============================================================================

describe("outside a git repository", () => {
	test("invalidateForCommit returns null instead of throwing", async () => {
		const tracker = newTracker();
		addDocument(tracker, "d-1", "file_summary", "src/a.ts");

		// mkdtemp lands under the OS temp root, which is not inside any repo.
		const counts = await invalidateForCommit(workDir, tracker, BRANCH);
		expect(counts).toBeNull();

		// Nothing was invalidated on a guess.
		expect(tracker.getDocumentProvenance(BRANCH, "d-1")?.isValid).toBe(true);
		expect(documentCount(tracker)).toBe(1);

		tracker.close();
	});

	test("the post-commit entry point degrades silently", async () => {
		const tracker = newTracker();
		addDocument(tracker, "d-1", "file_summary", "src/a.ts");

		// A rejected promise here would surface as an unhandled rejection inside a
		// git hook — the one place a new failure mode is least acceptable.
		await expect(
			runPostCommitInvalidation(workDir, tracker),
		).resolves.toBeNull();

		// A path that does not exist at all is the same story.
		await expect(
			runPostCommitInvalidation(join(workDir, "nope", "nope"), tracker),
		).resolves.toBeNull();

		// And nothing was invalidated on a guess.
		expect(tracker.getDocumentProvenance(BRANCH, "d-1")?.isValid).toBe(true);

		tracker.close();
	});
});

describe("inside a git repository", () => {
	test("walks HEAD's own diff and reports counts", async () => {
		// The tracker's storage stays in the temp dir; the repo it reasons about
		// is this checkout.
		const tracker = new FileTracker(join(workDir, "index.db"), process.cwd());

		const result = await runPostCommitInvalidation(process.cwd(), tracker);
		if (result === null) {
			throw new Error("expected this repo's HEAD to resolve");
		}

		expect(result.counts.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.counts.filesChanged).toBeGreaterThan(0);
		expect(result.summary).toContain("derived invalidated");

		// The commit it attributed the invalidation to is anchored and orderable.
		expect(tracker.getCommitOrdinal(result.counts.commitSha)).toBeGreaterThan(
			0,
		);

		tracker.close();
	});
});

// ============================================================================
// Staleness report
// ============================================================================

describe("staleness report", () => {
	test("summarises by class and lists the observations a human must judge", () => {
		const tracker = newTracker();

		addDocument(tracker, "d-1", "file_summary", "src/a.ts");
		addDocument(tracker, "d-2", "symbol_summary", "src/b.ts");
		addDocument(tracker, "o-1", "session_observation", "src/a.ts");
		addDocument(tracker, "o-2", "project_doc", "src/b.ts");
		addDocument(tracker, "e-1", "framework_doc", "src/a.ts");

		invalidateForChangedFiles(tracker, BRANCH, {
			changedPaths: ["src/a.ts"],
			commitSha: SHA,
		});

		const report = getStalenessReport(tracker, BRANCH);

		expect(report.byClass.derived.total).toBe(2);
		expect(report.byClass.derived.invalidated).toBe(1);
		expect(report.byClass.derived.stale).toBe(0);

		expect(report.byClass.observed.total).toBe(2);
		expect(report.byClass.observed.invalidated).toBe(0);
		expect(report.byClass.observed.stale).toBe(1);

		// External is inert by construction.
		expect(report.byClass.external.total).toBe(1);
		expect(report.byClass.external.invalidated).toBe(0);
		expect(report.byClass.external.stale).toBe(0);

		expect(report.totals.total).toBe(5);

		// The actionable list: observations kept because nothing can regenerate
		// them, flagged because the code under them moved.
		expect(report.staleObserved).toHaveLength(1);
		expect(report.staleObserved[0].id).toBe("o-1");
		expect(report.staleObserved[0].documentType).toBe("session_observation");
		expect(report.staleObserved[0].staleAtCommit).toBe(SHA);

		tracker.close();
	});

	test("is empty and cheap on a fresh index", () => {
		const tracker = newTracker();

		const report = getStalenessReport(tracker, BRANCH);
		expect(report.totals).toEqual({ total: 0, invalidated: 0, stale: 0 });
		expect(report.byType).toEqual([]);
		expect(report.staleObserved).toEqual([]);

		tracker.close();
	});
});
