/**
 * The stored-path convention (architecture §3.1): `toRepoRelative` on the way
 * in, `fromStoredPath` on the way out, and the two are inverses.
 */

import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fromStoredPath,
	isStoredRepoPath,
	toRepoRelative,
} from "../../../src/core/repo-path.js";

describe("toRepoRelative", () => {
	const root = "/repo";

	test("a nested file is POSIX and relative, with no leading ./", () => {
		expect(toRepoRelative(root, "/repo/src/a.ts")).toBe("src/a.ts");
		expect(toRepoRelative(root, "/repo/a.ts")).toBe("a.ts");
	});

	test("the root itself has no stored path", () => {
		expect(toRepoRelative(root, "/repo")).toBeNull();
	});

	test("a path outside the root is REJECTED, never stored as a ../ path", () => {
		expect(toRepoRelative(root, "/other/a.ts")).toBeNull();
		expect(toRepoRelative(root, "/repo/../other/a.ts")).toBeNull();
	});

	test("a sibling that shares the root's prefix is outside it", () => {
		expect(toRepoRelative("/repo", "/repo2/a.ts")).toBeNull();
	});

	test("a relative input is rejected: only an absolute path can be placed under a root", () => {
		expect(toRepoRelative(root, "src/a.ts")).toBeNull();
	});

	test("the same file under a symlinked spelling of the root is inside it (decision I-3)", () => {
		// The seam realpaths pathRoot; a caller may not. `/tmp` vs `/private/tmp`
		// on darwin is this case, and it would otherwise skip every file.
		const real = realpathSync(mkdtempSync(join(tmpdir(), "repo-path-")));
		const alias = `${real}-alias`;
		symlinkSync(real, alias);
		try {
			mkdirSync(join(real, "src"));
			writeFileSync(join(real, "src", "a.ts"), "x");
			expect(toRepoRelative(real, join(alias, "src", "a.ts"))).toBe("src/a.ts");
			// A deleted file's path converts too: the walk-up finds its directory.
			expect(toRepoRelative(real, join(alias, "src", "gone.ts"))).toBe(
				"src/gone.ts",
			);
		} finally {
			rmSync(alias, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});
});

describe("fromStoredPath is toRepoRelative's inverse, for repo rows only", () => {
	test("a repo row comes back absolute under the root", () => {
		expect(
			fromStoredPath("/repo", { filePath: "src/a.ts", pathKind: "repo" }),
		).toBe(join("/repo", "src/a.ts"));
	});

	test("a synthetic row comes back exactly as stored", () => {
		expect(
			fromStoredPath("/repo", {
				filePath: "docs:react",
				pathKind: "synthetic",
			}),
		).toBe("docs:react");
	});

	test("a row written before v4 (no pathKind) is untouched", () => {
		expect(fromStoredPath("/repo", { filePath: "/repo/src/a.ts" })).toBe(
			"/repo/src/a.ts",
		);
	});

	test("round trip", () => {
		const abs = "/repo/a/b/c.ts";
		const stored = toRepoRelative("/repo", abs);
		expect(stored).toBe("a/b/c.ts");
		expect(
			fromStoredPath("/repo", { filePath: stored as string, pathKind: "repo" }),
		).toBe(abs);
	});
});

describe("isStoredRepoPath", () => {
	test("accepts the convention and nothing else", () => {
		expect(isStoredRepoPath("src/a.ts")).toBe(true);
		expect(isStoredRepoPath("src/my_file%.ts")).toBe(true);
		expect(isStoredRepoPath("")).toBe(false);
		expect(isStoredRepoPath("/repo/src/a.ts")).toBe(false);
		expect(isStoredRepoPath("../x.ts")).toBe(false);
		expect(isStoredRepoPath("src/../../x.ts")).toBe(false);
	});
});
