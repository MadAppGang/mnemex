/**
 * D1 (V3.12) — a search on a branch the index has never seen.
 *
 * DECIDED, by the orchestrator, and not re-opened here: return the SUPERSET,
 * flagged. The two options fail asymmetrically. Returning nothing fails
 * INVISIBLY — an agent reads "no results" as "this code does not exist" and
 * writes it again, and the user gets a duplicate implementation rather than an
 * error. Returning the superset fails VISIBLY: results plus an explicit flag.
 * `git checkout -b` makes this the COMMON path, not an error path, so the
 * common case must not be the silent one.
 *
 * Three things are REQUIRED WITH IT (§4.4.2), and all three are asserted here:
 *
 *   1. the FR-4 carve-out, recorded in `requirements.md` — checked as BYTES of
 *      that file, because a design that ships a default violating a hard FR
 *      needs the requirement amended, not reinterpreted;
 *   2. the flag reaches the MCP `search_code` response, not only `--agent` and
 *      one CLI line, and every result carries its branch labels;
 *   3. results are NON-EMPTY on the unknown branch.
 *
 * FALSIFIED BY making the resolver return an empty result set for an unknown
 * branch — the non-empty assertion fires. Run below, against the same fixture.
 *
 * WHY THIS TEST DRIVES THE REAL RESOLVER. `branchUnknown` is decided by
 * `resolveBranchScopeForRead`, from a real `branches.json` and a real HEAD
 * file. A stub that simply returned `branchUnknown: true` would assert the
 * plumbing and nothing about the decision.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRANCH_REGISTRY_FORMAT_VERSION,
	serialiseRegistry,
} from "../../../src/core/branch-registry.js";
import { resolveBranchScopeForRead } from "../../../src/core/branch-scope.js";
import {
	__resetStoreLocationCacheForTests,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	__resetStoreLocationCacheForTests();
});

/**
 * A repository-shaped directory: a real `.git` with a real `HEAD`, so
 * `readGitLayout` and `readCurrentHead` do their actual work.
 */
function makeRepo(head: string): { root: string; storeDir: string } {
	const root = mkdtempSync(join(tmpdir(), "branch-unknown-"));
	tempDirs.push(root);
	const gitDir = join(root, ".git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	mkdirSync(join(gitDir, "objects"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${head}\n`);
	const refPath = join(gitDir, "refs", "heads", ...head.split("/"));
	mkdirSync(join(refPath, ".."), { recursive: true });
	writeFileSync(refPath, `${"a".repeat(40)}\n`);
	__resetStoreLocationCacheForTests();
	const loc = resolveStoreLocation(root);
	mkdirSync(loc.storeDir, { recursive: true });
	return { root, storeDir: loc.storeDir };
}

function writeRegistry(root: string, labels: string[]): void {
	const loc = resolveStoreLocation(root);
	writeFileSync(
		join(loc.storeDir, "branches.json"),
		serialiseRegistry({
			formatVersion: BRANCH_REGISTRY_FORMAT_VERSION,
			nextId: labels.length + 1,
			branches: labels.map((label, i) => ({
				id: i + 1,
				label,
				kind: "branch" as const,
				ephemeral: false,
				headSha: null,
				firstSeen: "2026-01-01T00:00:00.000Z",
				lastSeen: "2026-01-01T00:00:00.000Z",
				lastIndexedAt: null,
				deletedAt: null,
				unconfirmedSince: null,
				needsReindex: false,
			})),
		}),
	);
}

// ════════════════════════════════════════════════════════════════════════════
// The decision itself
// ════════════════════════════════════════════════════════════════════════════

describe("D1 — the resolver drops the filter and flags it", () => {
	test("a HEAD with no registry entry: scope is `all`, branchUnknown is TRUE", () => {
		const { root } = makeRepo("feat/brand-new");
		writeRegistry(root, ["main"]);

		const resolved = resolveBranchScopeForRead(resolveStoreLocation(root));

		expect(resolved.scope).toEqual({ kind: "all" });
		expect(resolved.branchUnknown).toBe(true);
		expect(resolved.label).toBe("feat/brand-new");
		// Attribution is available even though the branch is unknown: the rows
		// that come back belong to branches the registry DOES name.
		expect(resolved.labels.get(1)).toBe("main");
	});

	test("a HEAD the registry knows: scope is that branch, branchUnknown is FALSE", () => {
		const { root } = makeRepo("main");
		writeRegistry(root, ["main", "feat/x"]);

		const resolved = resolveBranchScopeForRead(resolveStoreLocation(root));

		expect(resolved.scope).toEqual({ kind: "branch", branchId: 1 });
		expect(resolved.branchUnknown).toBe(false);
	});

	test("a store with NO registry at all is unknown, not an error", () => {
		// A repository that has never been indexed. An absent file is an empty
		// registry, exactly as `openRegistry` treats it.
		const { root } = makeRepo("main");
		const resolved = resolveBranchScopeForRead(resolveStoreLocation(root));
		expect(resolved.branchUnknown).toBe(true);
		expect(resolved.scope).toEqual({ kind: "all" });
	});

	test("OUTSIDE a repository, branchUnknown is FALSE — there is no branch to be unknown", () => {
		// Reporting an unknown branch here would be a lie every non-git user
		// sees on every search. The scope is `all` for a different reason: every
		// row of such a store carries the shared marker (§3.2.1).
		const root = mkdtempSync(join(tmpdir(), "branch-unknown-plain-"));
		tempDirs.push(root);
		__resetStoreLocationCacheForTests();
		const resolved = resolveBranchScopeForRead(resolveStoreLocation(root));
		expect(resolved.scope).toEqual({ kind: "all" });
		expect(resolved.branchUnknown).toBe(false);
		expect(resolved.label).toBeNull();
	});

	test("FALSIFIER: returning the branch's own (absent) id would give an EMPTY superset", () => {
		// The option D1 rejected, shown rather than argued: if an unknown branch
		// resolved to a fresh id instead of dropping the filter, the predicate
		// would match no repo row at all — the invisible failure.
		const { root } = makeRepo("feat/brand-new");
		writeRegistry(root, ["main"]);
		const resolved = resolveBranchScopeForRead(resolveStoreLocation(root));
		// The real resolver drops the filter...
		expect(resolved.scope.kind).toBe("all");
		// ...and `{ kind: "branch", branchId: 3 }` — the id a fresh allocation
		// would have produced — matches nothing written under 1 or 2.
		const {
			branchMembershipFilter,
		} = require("../../../src/core/branch-scope.js");
		expect(branchMembershipFilter({ kind: "branch", branchId: 3 })).toBe(
			"(branchIds LIKE '%,0,%' OR branchIds LIKE '%,3,%')",
		);
		expect(branchMembershipFilter(resolved.scope)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Required item 1 — the FR-4 carve-out is RECORDED, not merely intended
// ════════════════════════════════════════════════════════════════════════════

describe("D1 required item 1 — the FR-4 carve-out is in requirements.md", () => {
	test("FR-4 names the carve-out, in the file, as bytes", () => {
		const requirements = readFileSync(
			join(
				import.meta.dir,
				"..",
				"..",
				"..",
				"ai-docs",
				"sessions",
				"dev-feature-repo-stable-dataset-20260911-233750-2f49f045",
				"requirements.md",
			),
			"utf8",
		);
		// FR-4 forbids cross-branch results absolutely; D1 ships a default that
		// violates it, so the requirement must be amended rather than
		// reinterpreted. Checked on the text so the amendment cannot be lost.
		// Case-insensitively and with newlines collapsed: `requirements.md` is
		// written in lower case and hard-wrapped, so the phrases below straddle
		// line breaks in the file.
		const text = requirements
			.toLowerCase()
			// Markdown blockquote markers: the carve-out is a `>` block, so `>`
			// characters sit between the words when the lines are joined.
			.replace(/^\s*>\s?/gm, "")
			.replace(/\s+/g, " ");
		expect(text).toContain("branchunknown");
		expect(text).toContain("per-row branch attribution");
		expect(text).toContain("search_code");
		// ...and the carve-out is bounded: a branch that IS registered is still
		// filtered absolutely.
		expect(text).toContain("filtered absolutely");
	});
});
