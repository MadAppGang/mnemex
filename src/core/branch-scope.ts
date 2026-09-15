/**
 * `BranchScope` — the read-side scope, and the ONE place that renders it into a
 * LanceDB predicate (architecture §4.4).
 *
 * A leaf module on purpose: `tracker.ts`, the MCP tools and the retrieval
 * backends all need the type, and none of them may pull in `store.ts` (and with
 * it LanceDB) to get it. It imports `BRANCH_ID_SHARED` from the registry, which
 * is itself a leaf.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE IS A PER-CALL ARGUMENT, NEVER CONSTRUCTION STATE (§2.5). The MCP server
 * is long-lived and the user switches branches underneath it; a `branchId`
 * captured at construction answers the previous branch for the rest of the
 * process's life (V3.10).
 *
 * ID 0 MEANS EXACTLY ONE THING, and it is not "repo-wide" (§4.4). Code rows are
 * written `,1,` and widened to `,1,2,`, so they never carry 0; a "repo-wide"
 * query built as `branchMembershipFilter({branchId: 0})` would return docs rows
 * only. Repo-wide is `{ kind: "all" }`, which emits NO predicate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { BRANCH_ID_SHARED, readBranchRegistry } from "./branch-registry.js";
import { readCurrentHead } from "./git-layout.js";
import { resolveStoreLocation, type StoreLocation } from "./store-location.js";

export { BRANCH_ID_SHARED };

/**
 * What a read is allowed to see.
 *
 * - `branch` — this branch's rows plus the shared ones (`,0,`: docs,
 *   observations). `branchId >= 1`, always a registry id.
 * - `all` — no predicate at all. `map`, `doctor`, every read in a store with no
 *   git layout, and D1's unknown-branch fallback (§4.4.2).
 */
export type BranchScope =
	| { readonly kind: "branch"; readonly branchId: number }
	| { readonly kind: "all" };

/** The repo-wide scope. A named constant so the intent is greppable. */
export const SCOPE_ALL: BranchScope = { kind: "all" };

/** `{ kind: "branch" }` with the id checked at the boundary. */
export function branchScope(branchId: number): BranchScope {
	assertQueryableBranchId(branchId, "branchScope");
	return { kind: "branch", branchId };
}

function assertQueryableBranchId(branchId: number, who: string): void {
	if (!Number.isSafeInteger(branchId) || branchId < 1) {
		throw new RangeError(
			`${who}: ${String(branchId)} is not a branch id (a safe integer >= 1). ` +
				`${BRANCH_ID_SHARED} is the shared-row marker, never a scope — repo-wide is { kind: "all" }`,
		);
	}
}

/**
 * The storage predicate for `scope`, or `null` for "no predicate at all".
 *
 * CLAUDE.md #22, and architecture §3.7 row 1 for the full contract. The value
 * interpolated here is an integer THIS MODULE checked — never user text — so no
 * escaper applies: not `escapeSqlLiteral` (there is nothing to quote-double)
 * and emphatically not `escapeFilterValue` (there is no `%` or `_` to
 * neutralise, and the pattern's own `%` are deliberate). The integer assertion
 * is what keeps that true, so it runs on every call and is not an `if (DEV)`.
 *
 * Branch NAMES never enter a predicate. Research warns that branch names
 * routinely contain `/`, `_` and `%`-adjacent characters, and `_` is a `LIKE`
 * wildcard — that is the `file\_summary` bug (#22) waiting to happen a third
 * time. An integer cannot be.
 *
 * The sentinel commas are what make `,1,` never match `,11,`.
 *
 * The `%,0,%` disjunct is load-bearing for docs and observation visibility
 * (§3.2.1 names the writers). It is not dead and must not be "cleaned up".
 */
export function branchMembershipFilter(scope: BranchScope): string | null {
	if (scope.kind === "all") return null;
	const id = scope.branchId;
	assertQueryableBranchId(id, "branchMembershipFilter");
	return `(branchIds LIKE '%,${BRANCH_ID_SHARED},%' OR branchIds LIKE '%,${id},%')`;
}

/**
 * What one read path resolved about the branch it is reading through.
 *
 * Produced per call by {@link resolveBranchScopeForRead}, never cached on a
 * long-lived object (§2.5, V3.10).
 */
export interface BranchScopeResolution {
	/** What the storage predicate is built from. */
	readonly scope: BranchScope;
	/**
	 * D1 (§4.4.2). TRUE only in the case D1 decides: inside a repository, HEAD
	 * read, and the registry holds no live entry for its label. The filter is
	 * then dropped (`scope` is `all`) and the caller MUST surface this — in the
	 * MCP `search_code` response, not only in `--agent`.
	 *
	 * FALSE in a store with no git layout: there is no branch there, so there is
	 * nothing unknown. `scope` is `all` for a different reason, and reporting an
	 * unknown branch would be a lie every non-git user sees on every search.
	 */
	readonly branchUnknown: boolean;
	/** The current HEAD's registry label, or null outside a repository. */
	readonly label: string | null;
	/** id → label, for the per-row attribution D1 requires. Every entry, live or not. */
	readonly labels: ReadonlyMap<number, string>;
}

/**
 * Resolve the scope for ONE read, from the store location alone.
 *
 * Read-only throughout: it re-reads HEAD (deliberately not memoized — the user
 * switches branches under a long-lived MCP server) and reads `branches.json`
 * without the store lock. It NEVER allocates an id: allocation is W-R1's, under
 * the lock, on the write path. A HEAD with no entry is D1's case, not a reason
 * to write.
 */
export function resolveBranchScopeForRead(
	loc: StoreLocation,
): BranchScopeResolution {
	if (loc.gitLayout === null) {
		// No git layout: every row of this store is stamped `,0,` (§3.2.1), so
		// "no predicate" and "every row" coincide and there is one code path.
		return {
			scope: SCOPE_ALL,
			branchUnknown: false,
			label: null,
			labels: new Map(),
		};
	}

	const label = readCurrentHead(loc.gitLayout).label;
	const file = readBranchRegistry(loc);
	const labels = new Map<number, string>();
	for (const entry of file.branches) labels.set(entry.id, entry.label);
	labels.set(BRANCH_ID_SHARED, SHARED_ROW_LABEL);

	const live = file.branches.find(
		(b) =>
			b.label === label && b.deletedAt === null && b.unconfirmedSince === null,
	);
	if (live === undefined) {
		// D1: the superset, flagged. Returning nothing fails INVISIBLY — an agent
		// reads "no results" as "this code does not exist" and writes it again.
		return { scope: SCOPE_ALL, branchUnknown: true, label, labels };
	}
	return { scope: branchScope(live.id), branchUnknown: false, label, labels };
}

/**
 * {@link resolveBranchScopeForRead} for a caller that holds a project path
 * rather than a resolved location. Resolution goes through the ONE seam
 * (`resolveStoreLocation`, decision I-8), which memoizes, so this is cheap
 * enough to call per request — and it must be per request, never cached on a
 * long-lived object (§2.5, V3.10).
 */
export function resolveBranchScopeForProject(
	projectPath: string,
): BranchScopeResolution {
	return resolveBranchScopeForRead(resolveStoreLocation(projectPath));
}

/**
 * The scope that sees exactly the rows a WRITER under `branchId` produced.
 *
 * `BRANCH_ID_SHARED` is not a branch and `branchScope` refuses it, but it IS
 * what every row of a store with no repository layout carries, so "no
 * predicate" and "every row" coincide there and one code path serves both.
 * Used by the write path's own reads (the enricher's incremental check), where
 * the branch is the RUN's, not HEAD's.
 */
export function scopeForBranchId(branchId: number): BranchScope {
	return branchId === BRANCH_ID_SHARED ? SCOPE_ALL : branchScope(branchId);
}

/** The label reported for a row carrying the shared marker (docs, observations). */
export const SHARED_ROW_LABEL = "shared";

/**
 * The branch id a SQLITE read uses for `resolution`. THE ONE PLACE this choice
 * is made, and it is REPORTED to the orchestrator as a gap in D1's scope rather
 * than presented as settled.
 *
 * The chunk store has two scopes (`branch` and `all`), so D1 can drop the filter
 * and flag it. The tracker's tree-scoped tables have no `all`: §4.4.1 gives every
 * member a `branchId: number`, and V3.11b requires every statement to carry
 * `branch_id`. So when HEAD has no registry entry there is no id to pass.
 *
 * `BRANCH_ID_SHARED` is used, and it is NOT an invented value: it is the
 * existing, defined marker for "visible from every branch" (§3.2.1), it is
 * exactly what the indexer already writes in a store with no git layout, and in
 * a git store no graph or `files` row ever carries it — so a read scoped to it
 * returns the EMPTY graph, which is the truthful answer for a branch that has
 * never been indexed. Nothing is written under it: every write path holds a
 * real registry id from `resolveId` (W-R1), under the store lock.
 *
 * WHAT IS UNRESOLVED, for the orchestrator: D1 argues that empty fails
 * INVISIBLY, and that argument applies to `mnemex symbol` / `callers` /
 * `map` / `dead-code` on a fresh branch just as it does to `search`. D1's
 * required surfacing, and the FR-4 carve-out in `requirements.md`, name only
 * the search response. Extending either to the graph commands is a product
 * decision, not an implementation one. `branchUnknown` is carried on the
 * resolution so a caller CAN surface it; no graph caller is required to yet.
 */
export function graphBranchIdForRead(
	resolution: BranchScopeResolution,
): number {
	return resolution.scope.kind === "branch"
		? resolution.scope.branchId
		: BRANCH_ID_SHARED;
}

/** Row ids → the labels a caller shows. Unknown ids are rendered as `#<id>`. */
export function labelBranchIds(
	ids: readonly number[],
	labels: ReadonlyMap<number, string>,
): string[] {
	return ids.map((id) => labels.get(id) ?? `#${id}`);
}

/**
 * The stored `branchIds` cell (`,1,2,`) as ids. Unparseable input yields an
 * empty list rather than throwing: this feeds per-row ATTRIBUTION (§4.4.2), and
 * a malformed cell must not fail a search that already found the row.
 */
export function decodeBranchIds(cell: unknown): number[] {
	if (typeof cell !== "string" || cell.length === 0) return [];
	const ids: number[] = [];
	for (const part of cell.split(",")) {
		if (part === "") continue;
		const id = Number(part);
		if (Number.isSafeInteger(id) && id >= 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
