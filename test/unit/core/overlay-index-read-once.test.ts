/**
 * CUR-2 (step 3, P-E1) — the indexer hashes the bytes it chunked.
 *
 * The overlay's ONLY proof that a file is index-current is
 * `tracker.content_hash == sha256(bytes on disk)` (architecture §5, "Named
 * sets": tracker `mtime` is never consulted). That proof is sound only if the
 * tracker's hash describes the bytes whose chunks are in the store. Before
 * P-E1 the indexer read the file as a string, chunked it, and hashed a SECOND
 * read (`computeFileHash`), so a save between the two recorded the NEW bytes'
 * hash beside the OLD bytes' chunks — and the overlay would then have called
 * that file current and served its stale rows.
 *
 * Measured through a REAL `Indexer.index()` in a sandboxed child
 * (`overlay-index-child.ts`), with the save injected right after the first read
 * of the target. Asserted on the tracker row and the stored chunk text, read
 * by this process through connections of its own.
 *
 * FALSIFIED BY restoring the second read (`computeFileHash(filePath)` after
 * `readFileSync(filePath, "utf-8")`): the tracker hash then equals the NEW
 * bytes' hash while the chunks hold the OLD text.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTracker } from "../../../src/core/tracker.js";
import {
	BM25_ONLY,
	collect,
	sandboxEnv,
	storeRows,
} from "../../helpers/v4-fixtures.js";

const CHILD = join(
	import.meta.dir,
	"..",
	"..",
	"helpers",
	"overlay-index-child.ts",
);

const scratches: string[] = [];
afterAll(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");

describe("CUR-2 — P-E1: the tracker hash describes the chunked bytes", () => {
	test("a save between the indexer's read and its hash does not split them (A)", async () => {
		const scratch = realpathSync.native(
			mkdtempSync(join(tmpdir(), "mnemex-cur2-")),
		);
		scratches.push(scratch);
		const project = join(scratch, "project");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));

		const oldText =
			"export function oldMarker(n: number): number {\n\treturn n + 1;\n}\n";
		const newText =
			"export function newMarker(n: number): number {\n\treturn n + 2;\n}\n// saved mid-index\n";
		const target = join(project, "src", "target.ts");
		writeFileSync(target, oldText);
		writeFileSync(
			join(project, "src", "other.ts"),
			"export const other = 1;\n",
		);
		const newContentFile = join(scratch, "new-content.ts");
		writeFileSync(newContentFile, newText);

		const run = await collect(
			Bun.spawn(
				[
					process.execPath,
					"--env-file=/dev/null",
					CHILD,
					project,
					target,
					newContentFile,
				],
				{
					cwd: project,
					env: sandboxEnv(scratch),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
		expect(run.stderr).not.toContain("must point inside tmpdir");
		expect(run.exitCode).toBe(0);
		expect(run.result?.injected).toBe(true);

		// The CHUNKS hold the OLD text: the bytes the indexer read first. Code
		// units come from a later, separate read (symbol/unit extraction), so
		// only `code_chunk` rows describe the bytes the tracker hash must match.
		const rows = await storeRows(join(project, ".mnemex", "vectors"));
		const targetRows = rows.filter(
			(r) => r.filePath === "src/target.ts" && r.documentType === "code_chunk",
		);
		expect(targetRows.length).toBeGreaterThan(0);
		const stored = targetRows.map((r) => String(r.content)).join("\n");
		expect(stored).toContain("oldMarker");
		expect(stored).not.toContain("newMarker");

		// …and the tracker hash is THOSE bytes' hash, not the save's.
		const tracker = createFileTracker(
			join(project, ".mnemex", "index.db"),
			project,
		);
		try {
			const state = tracker.getFileState(0, "src/target.ts");
			expect(state).not.toBeNull();
			expect(state?.contentHash).toBe(sha256(Buffer.from(oldText, "utf8")));
			expect(state?.contentHash).not.toBe(sha256(Buffer.from(newText, "utf8")));
		} finally {
			tracker.close();
		}
	}, 60_000);
});
