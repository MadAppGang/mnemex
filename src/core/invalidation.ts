/**
 * Commit-Driven Memory Invalidation
 *
 * Storage (the `commits` table and the provenance columns) lives in
 * `tracker.ts`. This file is the POLICY: given that a commit changed a set of
 * files, which stored memories are now wrong, which are merely suspect, and
 * which the commit says nothing about.
 *
 * Deciding that a stored memory has gone invalid is the hard part of memory —
 * for conversational memory it needs commonsense inference and frontier models
 * sit near coin-flip accuracy on it. For a codebase it does not: a commit is a
 * ground-truth statement about which files changed. That determinism is the
 * whole advantage, and it is only an advantage if the decision is right about
 * what a file change actually implies, which differs by document type.
 *
 * Three classes, not two:
 *
 *   DERIVED  — re-derivable from repo source. A source change means the derived
 *              text is stale in the strong sense; supersede it and re-derive.
 *   OBSERVED — written by a human or an agent and NOT re-derivable. A source
 *              change is evidence it may be wrong, never proof. Flag it; never
 *              destroy it. A wrong flag is recoverable, a deleted observation
 *              is not.
 *   EXTERNAL — derived from upstream documentation, not from this repo. A commit
 *              here says NOTHING about React's docs. Wiring these to repo
 *              commits would invalidate correct documents on every unrelated
 *              commit, which is worse than not invalidating at all.
 */

import { GitDiffChangeDetector } from "../cloud/git-diff.js";
import type { DocumentType } from "../types.js";
import {
	type CommitProvenance,
	type DocumentStatusCount,
	type IFileTracker,
	resolveHeadCommit,
	type StaleDocument,
} from "./tracker.js";

// ============================================================================
// Taxonomy
// ============================================================================

/** What a repo commit is allowed to conclude about a document */
export type DocumentClass = "derived" | "observed" | "external";

/**
 * The single source of truth for invalidation policy.
 *
 * Typed as a total `Record<DocumentType, DocumentClass>` on purpose. Adding a
 * member to `DocumentType` without adding it here is a compile error, so a new
 * document type cannot silently inherit a policy nobody chose for it. A
 * `switch` with a `default` would accept the new type in silence and give it
 * whatever the default branch happened to be — which is exactly how an
 * unrecoverable observation ends up in the auto-delete path.
 */
export const DOCUMENT_CLASS: Record<DocumentType, DocumentClass> = {
	// Derived from repo source — re-derivable, so safe to supersede.
	code_chunk: "derived",
	file_summary: "derived",
	symbol_summary: "derived",
	idiom: "derived",
	usage_example: "derived",
	anti_pattern: "derived",

	// Written by humans/agents — not re-derivable, so never auto-destroyed.
	session_observation: "observed",
	project_doc: "observed",

	// Upstream documentation — a repo commit carries no information about it.
	framework_doc: "external",
	best_practice: "external",
	api_reference: "external",
};

/** Every document type, derived from the classification so the two cannot drift */
export const ALL_DOCUMENT_TYPES = Object.keys(DOCUMENT_CLASS) as DocumentType[];

function typesOfClass(documentClass: DocumentClass): DocumentType[] {
	return ALL_DOCUMENT_TYPES.filter(
		(type) => DOCUMENT_CLASS[type] === documentClass,
	);
}

export const DERIVED_DOCUMENT_TYPES = typesOfClass("derived");
export const OBSERVED_DOCUMENT_TYPES = typesOfClass("observed");
export const EXTERNAL_DOCUMENT_TYPES = typesOfClass("external");

/**
 * Class of a document type.
 *
 * Falls back to "observed" for a string that is not a known document type —
 * the conservative direction. An unrecognised type is treated as something we
 * cannot regenerate, so the worst case is an unnecessary flag rather than the
 * destruction of a document whose provenance we failed to understand.
 */
export function classifyDocumentType(
	documentType: DocumentType | string,
): DocumentClass {
	return DOCUMENT_CLASS[documentType as DocumentType] ?? "observed";
}

// ============================================================================
// Result Types
// ============================================================================

export interface InvalidationCounts {
	/** Commit the invalidation was attributed to */
	commitSha: string;
	/** Changed paths considered */
	filesChanged: number;
	/** DERIVED documents superseded (invalidated_at_commit set) */
	derivedInvalidated: number;
	/** OBSERVED documents flagged suspect but kept */
	observedFlaggedStale: number;
	/** EXTERNAL documents attached to changed files, deliberately untouched */
	externalSkipped: number;
	/** Files whose derived enrichment was queued for re-derivation */
	filesQueuedForReEnrichment: number;
}

export interface StalenessClassSummary {
	total: number;
	invalidated: number;
	stale: number;
}

export interface StalenessReport {
	byClass: Record<DocumentClass, StalenessClassSummary>;
	byType: DocumentStatusCount[];
	totals: StalenessClassSummary;
	/** The documents a human actually has to look at */
	staleObserved: StaleDocument[];
}

// ============================================================================
// Invalidation
// ============================================================================

/**
 * Apply the three-class policy to a set of changed paths.
 *
 * Pure with respect to git: the caller supplies the diff. Everything here is
 * batched — a commit that touches 5000 files issues a handful of statements,
 * not 5000. Nothing is ever deleted.
 */
export function invalidateForChangedFiles(
	tracker: IFileTracker,
	branchId: number,
	options: { changedPaths: string[]; commitSha: string },
): InvalidationCounts {
	const { commitSha } = options;

	// Dedup first: a rename contributes two paths, and a diff can list the same
	// path twice across status letters.
	const changedPaths = [...new Set(options.changedPaths.filter(Boolean))];

	const counts: InvalidationCounts = {
		commitSha,
		filesChanged: changedPaths.length,
		derivedInvalidated: 0,
		observedFlaggedStale: 0,
		externalSkipped: 0,
		filesQueuedForReEnrichment: 0,
	};

	if (changedPaths.length === 0) {
		return counts;
	}

	// DERIVED: supersede and queue re-derivation.
	// Every one of these is a PATH-keyed UPDATE that `hook-manager` drives on
	// EVERY commit. Unscoped, a commit on one branch invalidated every other
	// branch's summaries for the same path — `deleteSymbolsByFile`'s shape, on
	// the documents side (§4.4.1).
	counts.derivedInvalidated = tracker.markDocumentsInvalidated(
		branchId,
		changedPaths,
		DERIVED_DOCUMENT_TYPES,
		commitSha,
	);
	counts.filesQueuedForReEnrichment = tracker.queueReEnrichment(
		branchId,
		changedPaths,
		DERIVED_DOCUMENT_TYPES,
	);

	// OBSERVED: flag, keep, leave invalidated_at_commit NULL.
	counts.observedFlaggedStale = tracker.markDocumentsStale(
		branchId,
		changedPaths,
		OBSERVED_DOCUMENT_TYPES,
		commitSha,
	);

	// EXTERNAL: counted so the exemption is visible in the report, never written.
	counts.externalSkipped = tracker.countDocumentsForPaths(
		branchId,
		changedPaths,
		EXTERNAL_DOCUMENT_TYPES,
	);

	return counts;
}

/**
 * Walk the diff of a commit and invalidate against it.
 *
 * One `git diff` per commit — never one per file. Defaults to HEAD against its
 * first parent, which is what a post-commit hook wants.
 *
 * Returns null, having changed nothing, for a non-git directory, a missing git
 * binary, an empty repository or any git failure. Invalidation is an
 * improvement on the index; it must never become a new way for indexing or
 * committing to fail.
 */
export async function invalidateForCommit(
	projectPath: string,
	tracker: IFileTracker,
	branchId: number,
	options: { head?: CommitProvenance | null } = {},
): Promise<InvalidationCounts | null> {
	try {
		// Callers that already resolved HEAD this run (the indexer does, via
		// recordHeadCommit) pass it back in rather than paying for two more git
		// subprocesses to learn the same thing.
		const head =
			options.head !== undefined
				? options.head
				: await resolveHeadCommit(projectPath);
		if (!head) return null;

		const detector = new GitDiffChangeDetector(projectPath);

		// The initial commit has no parents — getParentShas returns [] and
		// getChangedFiles diffs against the empty tree for a null fromSha.
		const parents = await detector.getParentShas(head.sha);
		const fromSha = parents.length > 0 ? parents[0] : null;

		const changed = await detector.getChangedFiles(fromSha, head.sha);

		const changedPaths: string[] = [];
		for (const file of changed) {
			changedPaths.push(file.filePath);
			// A rename invalidates the documents filed under the old path too;
			// nothing else will ever revisit them.
			if (file.oldPath) changedPaths.push(file.oldPath);
		}

		// Anchor the commit before attributing anything to it, so the ordinal is
		// resolvable later.
		tracker.recordCommit(head.sha, head.ordinal, head.committedAt);

		return invalidateForChangedFiles(tracker, branchId, {
			changedPaths,
			commitSha: head.sha,
		});
	} catch {
		return null;
	}
}

// ============================================================================
// Staleness Report
// ============================================================================

/**
 * Current staleness state of the index.
 *
 * Read-only. This is what turns invalidation from invisible bookkeeping into a
 * thing a person can act on — in particular `staleObserved`, the observations
 * that were kept precisely because no pipeline can regenerate them.
 */
export function getStalenessReport(
	tracker: IFileTracker,
	branchId: number,
	options: { staleLimit?: number } = {},
): StalenessReport {
	const byType = tracker.getDocumentStatusCounts(branchId);

	const empty = (): StalenessClassSummary => ({
		total: 0,
		invalidated: 0,
		stale: 0,
	});

	const byClass: Record<DocumentClass, StalenessClassSummary> = {
		derived: empty(),
		observed: empty(),
		external: empty(),
	};
	const totals = empty();

	for (const row of byType) {
		const bucket = byClass[classifyDocumentType(row.documentType)];
		bucket.total += row.total;
		bucket.invalidated += row.invalidated;
		bucket.stale += row.stale;

		totals.total += row.total;
		totals.invalidated += row.invalidated;
		totals.stale += row.stale;
	}

	const staleObserved = tracker
		.getStaleDocuments(branchId, options.staleLimit)
		.filter((doc) => classifyDocumentType(doc.documentType) === "observed");

	return { byClass, byType, totals, staleObserved };
}

/** One-line human summary of an invalidation pass */
export function formatInvalidationCounts(counts: InvalidationCounts): string {
	return [
		`${counts.derivedInvalidated} derived invalidated`,
		`${counts.observedFlaggedStale} observed flagged stale`,
		`${counts.externalSkipped} external skipped`,
		`across ${counts.filesChanged} changed file(s) at ${counts.commitSha.slice(0, 8)}`,
	].join(", ");
}
