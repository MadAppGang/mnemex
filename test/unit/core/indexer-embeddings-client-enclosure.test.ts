/**
 * `installEmbeddingsClient()` is the SOLE assignment to both embeddings-client
 * fields — proved by PARSING `src/core/indexer.ts`, not by counting text.
 *
 * Why this check exists. `createEmbeddingsClient()` is called at two places in
 * the indexer: once in `initialize()`, and once in the `use-indexed` adoption
 * branch, which is the production default for a model mismatch and which
 * replaces the client wholesale. Convert only the first and one of two things
 * happens, both silent: the caching seam installed in `initialize()` is
 * destroyed by the adoption, or — if the raw client were a separate field
 * assigned separately — the seam keeps embedding with the CONFIGURED model
 * while the run records the ADOPTED one. The second writes vectors under the
 * wrong model identity into a cache that is shared by every repository on the
 * machine, and nothing in the run says so.
 *
 * Why a parse and not a regex. CLAUDE.md #24 is the record of a regex sweep
 * being bypassed three times before it was replaced with a tree-sitter analysis.
 * A text count cannot express ENCLOSURE — "assigned only inside this method" —
 * and it does not see `??=`, a subscript write (`this["embeddingsClient"] = x`)
 * or `Object.assign(this, …)`. This walks the syntax tree and asks where each
 * assignment actually sits.
 *
 * The parser is the one the repo already uses for source analysis over `src/**`
 * (`test/helpers/launch-capability-graph.ts` reaches for the same
 * `getParserManager()`); this file adds one visitor over one file rather than
 * threading a second mode through that 1,200-line helper. It reads source and
 * executes none.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "web-tree-sitter";
import { getParserManager } from "../../../src/parsers/parser-manager.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const INDEXER = join(REPO_ROOT, "src", "core", "indexer.ts");

/** The two fields that may only ever be written by one method. */
const GUARDED_FIELDS = ["embeddingsClient", "rawEmbeddingsClient"] as const;
const SOLE_WRITER = "installEmbeddingsClient";

interface Assignment {
	field: string;
	/** Name of the innermost enclosing method_definition, or null. */
	enclosingMethod: string | null;
	line: number;
	text: string;
}

/**
 * The property name a left-hand side writes on `this`, or null when the target
 * is not a `this` member.
 *
 * Handles both spellings that reach a field: `this.x` (member_expression) and
 * `this["x"]` (subscript_expression with a literal). A computed subscript with
 * a non-literal index is reported as `"<computed>"` so it can never pass by
 * being unreadable.
 */
function thisFieldWritten(left: Node): string | null {
	if (left.type === "member_expression") {
		const object = left.childForFieldName("object");
		const property = left.childForFieldName("property");
		if (object?.type !== "this" || property === null) return null;
		return property.text;
	}
	if (left.type === "subscript_expression") {
		const object = left.childForFieldName("object");
		const index = left.childForFieldName("index");
		if (object?.type !== "this" || index === null) return null;
		if (index.type === "string") return index.text.slice(1, -1);
		return "<computed>";
	}
	return null;
}

function enclosingMethodName(node: Node): string | null {
	let current: Node | null = node.parent;
	while (current !== null) {
		if (current.type === "method_definition") {
			return current.childForFieldName("name")?.text ?? "<anonymous>";
		}
		current = current.parent;
	}
	return null;
}

/**
 * Every call to `name(` in the file, with the method it sits in and where.
 * Used to pin PLACEMENT, which is a property no grep can express: two of this
 * feature's requirements are "this call happens in that method" and "this call
 * happens before that one".
 */
interface CallSite {
	callee: string;
	enclosingMethod: string | null;
	startIndex: number;
	line: number;
}

function collectCalls(root: Node, source: string): CallSite[] {
	const calls: CallSite[] = [];
	const visit = (node: Node): void => {
		if (node.type === "call_expression") {
			const fn = node.childForFieldName("function");
			if (fn !== null) {
				calls.push({
					callee: fn.text,
					enclosingMethod: enclosingMethodName(node),
					startIndex: node.startIndex,
					line: source.slice(0, node.startIndex).split("\n").length,
				});
			}
		}
		for (const child of node.namedChildren) {
			if (child !== null) visit(child);
		}
	};
	visit(root);
	return calls;
}

function collect(
	root: Node,
	source: string,
): {
	assignments: Assignment[];
	objectAssignOnThis: string[];
} {
	const assignments: Assignment[] = [];
	const objectAssignOnThis: string[] = [];

	const visit = (node: Node): void => {
		if (
			node.type === "assignment_expression" ||
			node.type === "augmented_assignment_expression"
		) {
			const left = node.childForFieldName("left");
			if (left !== null) {
				const field = thisFieldWritten(left);
				if (field !== null) {
					assignments.push({
						field,
						enclosingMethod: enclosingMethodName(node),
						line: source.slice(0, node.startIndex).split("\n").length,
						text: node.text.split("\n")[0] as string,
					});
				}
			}
		}

		// `Object.assign(this, …)` writes fields without any assignment node.
		if (node.type === "call_expression") {
			const fn = node.childForFieldName("function");
			const args = node.childForFieldName("arguments");
			if (
				fn?.text === "Object.assign" &&
				args?.namedChildren[0]?.type === "this"
			) {
				objectAssignOnThis.push(
					`line ${source.slice(0, node.startIndex).split("\n").length}: ${node.text.split("\n")[0]}`,
				);
			}
		}

		for (const child of node.namedChildren) {
			if (child !== null) visit(child);
		}
	};

	visit(root);
	return { assignments, objectAssignOnThis };
}

const source = readFileSync(INDEXER, "utf-8");
const parser = await getParserManager()
	.initialize()
	.then(() => getParserManager().getParser("typescript"));
if (!parser) throw new Error("typescript grammar unavailable");
const tree = parser.parse(source);
if (!tree?.rootNode) throw new Error("indexer.ts did not parse");
const { assignments, objectAssignOnThis } = collect(tree.rootNode, source);
const calls = collectCalls(tree.rootNode, source);

function only(callee: string): CallSite {
	const found = calls.filter((c) => c.callee === callee);
	if (found.length !== 1) {
		throw new Error(
			`expected exactly one call to ${callee}, found ${found.length}` +
				` (${found.map((f) => `line ${f.line} in ${f.enclosingMethod}`).join(", ")})`,
		);
	}
	return found[0] as CallSite;
}

describe("indexer.ts: installEmbeddingsClient is the sole assignment", () => {
	for (const field of GUARDED_FIELDS) {
		test(`this.${field} is assigned exactly once, inside ${SOLE_WRITER}`, () => {
			const writes = assignments.filter((a) => a.field === field);

			// EXACTLY ONE. Two would mean the field can describe two models.
			expect(
				writes.map((w) => `line ${w.line} in ${w.enclosingMethod}: ${w.text}`),
			).toHaveLength(1);
			// And it is LEXICALLY INSIDE the one writer. This is the part a text
			// count cannot express.
			expect(writes[0]?.enclosingMethod).toBe(SOLE_WRITER);
		});
	}

	test("no computed write to a `this` field anywhere in the file", () => {
		// `this[expr] = v` could target either guarded field and the check above
		// would never see it.
		const computed = assignments.filter((a) => a.field === "<computed>");
		expect(computed.map((c) => `line ${c.line}: ${c.text}`)).toEqual([]);
	});

	test("no Object.assign(this, …) anywhere in the file", () => {
		expect(objectAssignOnThis).toEqual([]);
	});

	test("both createEmbeddingsClient() call sites feed installEmbeddingsClient", () => {
		// The complement of the enclosure check: the sole writer is only useful if
		// every client construction reaches it. Both sites are arguments to
		// `this.installEmbeddingsClient(`, so no construction can bypass it.
		const constructions = [...source.matchAll(/createEmbeddingsClient\(\{/g)];
		expect(constructions).toHaveLength(2);
		for (const match of constructions) {
			const before = source.slice(Math.max(0, match.index - 200), match.index);
			expect(before).toContain("this.installEmbeddingsClient(");
		}
	});
});

describe("indexer.ts: where the cache is opened and swept", () => {
	test("openEmbedCache() is called in index(), BEFORE the global lock", () => {
		// The open sequence creates the directory, opens the file and takes a
		// brief exclusive lock for the WAL pragma — all before `busy_timeout` is
		// set at all, so its duration is not constant-bounded. Inside the locks
		// that is unbounded blocking against `isLockStale`'s 10 s heartbeat rule,
		// which is how a second indexer gets onto the same store. Outside them it
		// is not in the budget at all. Same reason `docsConfigPreLock` is resolved
		// where it is.
		const open = only("openEmbedCache");
		const lock = only("createGlobalIndexLock");
		expect(open.enclosingMethod).toBe("index");
		expect(lock.enclosingMethod).toBe("index");
		expect(open.startIndex).toBeLessThan(lock.startIndex);
	});

	test("enforceBudget() is called inside indexInternal, not after the locks", () => {
		// Deliberately NOT moved after the `finally` that releases the locks.
		// Process B sits in the global lock's poll loop and takes it the instant A
		// releases, so A's DELETE transactions and incremental vacuum would run
		// concurrently with B's indexing against the one shared cache file — B's
		// first write waits the clamped busy_timeout, gets SQLITE_BUSY, and
		// latches its persistent tier off for the whole run. Inside the lock the
		// global lock is what serialises indexers machine-wide.
		// Matched on the MEMBER, so an optional-chained or re-receivered spelling
		// in another method is caught rather than read as "no such call".
		const sweeps = calls.filter((c) => /(^|\.)enforceBudget$/.test(c.callee));
		expect(
			sweeps.map((sw) => `line ${sw.line} in ${sw.enclosingMethod}`),
		).toHaveLength(1);
		expect(sweeps[0]?.enclosingMethod).toBe("indexInternal");
	});

	test("the seam's three narrow members are only reached through cachingSeam()", () => {
		// `embedContentOf`, `keyFor` and `stats` are not on `IEmbeddingsClient`.
		// Reaching them off `this.embeddingsClient` with a cast would be a second
		// embedding code path that no test exercises and that bypasses the NFR-2
		// assertion inside `embedContentOf`.
		for (const member of ["embedContentOf", "keyFor"]) {
			const direct = calls.filter(
				(c) =>
					c.callee.startsWith(`this.embeddingsClient`) &&
					c.callee.endsWith(`.${member}`),
			);
			expect(direct.map((d) => `line ${d.line}: ${d.callee}`)).toEqual([]);
		}
	});
});
