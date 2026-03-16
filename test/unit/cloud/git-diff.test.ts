/**
 * Unit tests for GitDiffChangeDetector
 *
 * We mock child_process.exec so no real git repository is needed.
 * Each test injects the raw stdout string that the mocked exec will resolve.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ============================================================================
// Module mock setup
// ============================================================================

// We need to intercept calls to node:child_process exec.
// Bun's mock() lets us replace module exports.
//
// Because GitDiffChangeDetector imports execAsync via `promisify(exec)` at
// module load time, we mock the whole child_process module before importing
// the class.

let mockExecImpl: (
	cmd: string,
	opts: unknown,
) => Promise<{ stdout: string; stderr: string }>;

mock.module("node:child_process", () => ({
	exec: (
		cmd: string,
		opts: unknown,
		cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
	) => {
		// exec is callback-based; promisify wraps it — we simulate that callback
		mockExecImpl(cmd, opts)
			.then((result) => cb(null, result))
			.catch((err: Error) => cb(err, { stdout: "", stderr: "" }));
		// exec returns a ChildProcess — return a stub with an unref() no-op
		return { unref: () => {} };
	},
}));

// Import AFTER mocking
const { GitDiffChangeDetector } = await import(
	"../../../src/cloud/git-diff.js"
);

// ============================================================================
// Helpers
// ============================================================================

function makeDetector(): InstanceType<typeof GitDiffChangeDetector> {
	return new GitDiffChangeDetector("/fake/project");
}

function mockExec(stdout: string): void {
	mockExecImpl = async () => ({ stdout, stderr: "" });
}

function mockExecError(message: string): void {
	mockExecImpl = async () => {
		throw new Error(message);
	};
}

// ============================================================================
// Tests: getHeadSha
// ============================================================================

describe("GitDiffChangeDetector.getHeadSha", () => {
	test("returns trimmed SHA from git rev-parse HEAD", async () => {
		mockExec("abc123def456abc123def456abc123def456abc1\n");
		const detector = makeDetector();
		const sha = await detector.getHeadSha();
		expect(sha).toBe("abc123def456abc123def456abc123def456abc1");
	});

	test("strips surrounding whitespace", async () => {
		mockExec("  aabbcc1122334455667788990011223344556677  \n");
		const detector = makeDetector();
		const sha = await detector.getHeadSha();
		expect(sha).toBe("aabbcc1122334455667788990011223344556677");
	});
});

// ============================================================================
// Tests: getParentShas
// ============================================================================

describe("GitDiffChangeDetector.getParentShas", () => {
	test("returns a single parent SHA for a normal commit", async () => {
		mockExec("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\n");
		const detector = makeDetector();
		const parents = await detector.getParentShas(
			"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
		);
		expect(parents).toHaveLength(1);
		expect(parents[0]).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
	});

	test("returns two parent SHAs for a merge commit", async () => {
		mockExec(
			"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\n" +
				"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222\n",
		);
		const detector = makeDetector();
		const parents = await detector.getParentShas(
			"cccc3333cccc3333cccc3333cccc3333cccc3333",
		);
		expect(parents).toHaveLength(2);
		expect(parents[0]).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
		expect(parents[1]).toBe("bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");
	});

	test("returns empty array for initial commit (git exits non-zero)", async () => {
		mockExecError("unknown revision or path not in the working tree");
		const detector = makeDetector();
		const parents = await detector.getParentShas(
			"init0000init0000init0000init0000init0000",
		);
		expect(parents).toEqual([]);
	});

	test("filters out non-40-char lines (e.g. blank lines)", async () => {
		mockExec("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\n\n");
		const detector = makeDetector();
		const parents = await detector.getParentShas(
			"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
		);
		expect(parents).toHaveLength(1);
	});
});

// ============================================================================
// Tests: getChangedFiles — normal diff
// ============================================================================

describe("GitDiffChangeDetector.getChangedFiles — two commits", () => {
	test("parses added files", async () => {
		mockExec("A\tsrc/new-file.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("fromSha", "toSha");
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({ filePath: "src/new-file.ts", status: "added" });
	});

	test("parses modified files", async () => {
		mockExec("M\tsrc/existing.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("fromSha", "toSha");
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/existing.ts",
			status: "modified",
		});
	});

	test("parses deleted files", async () => {
		mockExec("D\tsrc/old-file.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("fromSha", "toSha");
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/old-file.ts",
			status: "deleted",
		});
	});

	test("parses renamed files", async () => {
		mockExec("R100\tsrc/old-name.ts\tsrc/new-name.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("fromSha", "toSha");
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/new-name.ts",
			status: "renamed",
			oldPath: "src/old-name.ts",
		});
	});

	test("parses multiple changes", async () => {
		mockExec("A\tsrc/a.ts\n" + "M\tsrc/b.ts\n" + "D\tsrc/c.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("sha1", "sha2");
		expect(files).toHaveLength(3);
		expect(files[0].status).toBe("added");
		expect(files[1].status).toBe("modified");
		expect(files[2].status).toBe("deleted");
	});

	test("returns empty array for empty diff output", async () => {
		mockExec("");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("sha1", "sha2");
		expect(files).toEqual([]);
	});

	test("skips blank lines", async () => {
		mockExec("A\tsrc/a.ts\n\n\nM\tsrc/b.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles("sha1", "sha2");
		expect(files).toHaveLength(2);
	});
});

// ============================================================================
// Tests: getChangedFiles — initial commit (fromSha is null)
// ============================================================================

describe("GitDiffChangeDetector.getChangedFiles — initial commit (fromSha=null)", () => {
	test("parses initial commit output (all files added)", async () => {
		// git diff-tree --root outputs the same A/M/D format
		mockExec("A\tsrc/main.ts\nA\tsrc/utils.ts\n");
		const detector = makeDetector();
		const files = await detector.getChangedFiles(null, "initSha");
		expect(files).toHaveLength(2);
		expect(files[0]).toEqual({ filePath: "src/main.ts", status: "added" });
		expect(files[1]).toEqual({ filePath: "src/utils.ts", status: "added" });
	});
});

// ============================================================================
// Tests: getDirtyFiles
// ============================================================================

describe("GitDiffChangeDetector.getDirtyFiles", () => {
	test("parses staged modification (M in index column)", async () => {
		mockExec("M  src/staged.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({ filePath: "src/staged.ts", status: "modified" });
	});

	test("parses working-tree modification (M in working column)", async () => {
		mockExec(" M src/unstaged.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/unstaged.ts",
			status: "modified",
		});
	});

	test("parses staged addition", async () => {
		mockExec("A  src/new.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({ filePath: "src/new.ts", status: "added" });
	});

	test("parses untracked file (?? prefix)", async () => {
		mockExec("?? src/untracked.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/untracked.ts",
			status: "untracked",
		});
	});

	test("parses working-tree deletion", async () => {
		mockExec(" D src/deleted.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({ filePath: "src/deleted.ts", status: "deleted" });
	});

	test("parses staged deletion (D in index column)", async () => {
		mockExec("D  src/staged-delete.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			filePath: "src/staged-delete.ts",
			status: "deleted",
		});
	});

	test("parses rename in index (R  old -> new)", async () => {
		mockExec("R  old/path.ts -> new/path.ts\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
		expect(files[0].status).toBe("modified");
		expect(files[0].filePath).toBe("new/path.ts");
	});

	test("handles mixed dirty state", async () => {
		mockExec(
			"M  src/a.ts\n" +
				" M src/b.ts\n" +
				"A  src/c.ts\n" +
				"?? src/d.ts\n" +
				" D src/e.ts\n",
		);
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(5);
		expect(files.map((f) => f.status)).toEqual([
			"modified",
			"modified",
			"added",
			"untracked",
			"deleted",
		]);
	});

	test("returns empty array for clean working tree", async () => {
		mockExec("");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toEqual([]);
	});

	test("skips lines shorter than 4 characters", async () => {
		mockExec("A  src/a.ts\n\n");
		const detector = makeDetector();
		const files = await detector.getDirtyFiles();
		expect(files).toHaveLength(1);
	});
});
