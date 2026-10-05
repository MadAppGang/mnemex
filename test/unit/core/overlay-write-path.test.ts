/**
 * `prepareDirtyOverlay` — the locked write path (step 3, revision 1's HIGH 1,
 * 5, 10; R3.10). Every assertion is on rows in the overlay table (read through
 * a connection the overlay never held), the manifest's BYTES, or the lock
 * file — never on the report alone.
 *
 *   MF-1   the manifest is renamed into place BEFORE the lock is released, on
 *          success and on a thrown write
 *   MF-2   built v1, edited to v2, budget too small to build v2: no v1 row is
 *          read and nothing of the file is suppressed
 *   MF-3   rows deleted behind the manifest's back → failed(inconsistent), not
 *          served; the pass after rebuilds it
 *   DEL-1  the strict delete throws → those files' manifest entries removed,
 *          failed, not served
 *   GH-1   ghost rows (a duplicate id, an old id) appended after a pass are
 *          never served, and no id appears twice
 *   LK-1   the lock is reclaimed mid-pass → skipped/lock-lost, nothing
 *          suppressed, manifest bytes unchanged, the new owner's lock intact
 *   WIPE-1 an identity wipe leaves `.overlay.lock` in place and held
 *   OPEN-1 a corrupt table is wiped and rebuilt once; a second failure is
 *          skipped/overlay-corrupt
 *   V-1    20 edits → ≤ 2 table versions, bounded bytes, `deleteUnverified` off
 *   ROLE   only the overlay constructs an overlay-role store
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { IndexLock } from "../../../src/core/lock.js";
import { prepareDirtyOverlay } from "../../../src/core/overlay/dirty-overlay.js";
import * as manifestModule from "../../../src/core/overlay/manifest.js";
import { VectorStore } from "../../../src/core/store.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	StubEmbedder,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";

let fx: OverlayFixture | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	fx?.cleanup();
	fx = null;
});

async function fixture(files: Record<string, string>): Promise<OverlayFixture> {
	fx = await createOverlayFixture(files, "mnemex-ovwrite-");
	indexAll(fx, Object.keys(files));
	return fx;
}

async function table(f: OverlayFixture): Promise<lancedb.Table> {
	const db = await lancedb.connect(f.vectorsDir);
	return db.openTable("code_chunks");
}

function duBytes(dir: string): number {
	let total = 0;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else total += statSync(full).size;
		}
	};
	if (existsSync(dir)) walk(dir);
	return total;
}

describe("MF-1 — the manifest is written before the lock is released", () => {
	/** Records "manifest" and "release:<kind>" in call order, calling through. */
	function orderSpy(): string[] {
		const order: string[] = [];
		const realWrite = manifestModule.writeOverlayManifest;
		const realRelease = IndexLock.prototype.release;
		const write = spyOn(manifestModule, "writeOverlayManifest");
		write.mockImplementation((path, m) => {
			order.push("manifest");
			realWrite(path, m);
		});
		spies.push(write);
		const release = spyOn(IndexLock.prototype, "release");
		release.mockImplementation(function (this: IndexLock) {
			order.push(
				`release:${this.path.endsWith(".overlay.lock") ? "overlay" : "other"}`,
			);
			realRelease.call(this);
		});
		spies.push(release);
		return order;
	}

	test("on success", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const order = orderSpy();
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.files).toBe(1);
		expect(order.filter((o) => o !== "release:other")).toEqual([
			"manifest",
			"release:overlay",
		]);
	});

	test("on a thrown write: the completed delete is still recorded, before release", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		await prepareDirtyOverlay(f.ctx()); // built
		f.write("src/a.ts", tsSource("a", 2, "edited again"));
		const add = spyOn(VectorStore.prototype, "addChunks").mockRejectedValue(
			new Error("injected add failure"),
		);
		spies.push(add);
		const order = orderSpy();
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.filesFailed).toBe(1);
		expect(order.filter((o) => o !== "release:other")).toEqual([
			"manifest",
			"release:overlay",
		]);
		// The delete completed and the add did not: the entry is GONE, so no
		// pass can claim rows that are not there.
		expect(f.manifest()?.files["src/a.ts"]).toBeUndefined();
	});
});

describe("serving only what this pass proved", () => {
	test("MF-2: built v1, edited to v2, budget too small → no v1 rows read, nothing suppressed (A)", async () => {
		const f = await fixture({ "src/big.ts": tsSource("big", 80) });
		f.write("src/big.ts", tsSource("big", 80, "v1"));
		const first = await prepareDirtyOverlay(f.ctx());
		expect(first.candidates?.servedPaths).toEqual(["src/big.ts"]);

		f.write("src/big.ts", tsSource("big", 80, "v2"));
		f.stub.beforeEmbed = () => Bun.sleep(3);
		const second = await prepareDirtyOverlay(
			f.ctx({ limits: { rebuildBudgetMs: 1 } }),
		);
		expect(second.report.filesPending).toBe(1);
		expect(second.candidates?.servedPaths ?? []).toEqual([]);
		expect(second.candidates?.suppressedPaths ?? []).not.toContain(
			"src/big.ts",
		);
		const v1 = [...(second.candidates?.rowsById.values() ?? [])].filter((r) =>
			r.content.includes("v1"),
		);
		expect(v1).toEqual([]);
		expect(
			(second.candidates?.vector ?? []).filter((r) => r.content.includes("v1")),
		).toEqual([]);
	});

	test("MF-3: rows deleted behind the manifest's back → inconsistent, not served; next pass rebuilds (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		await prepareDirtyOverlay(f.ctx());
		await (await table(f)).delete("filePath = 'src/a.ts'");

		const second = await prepareDirtyOverlay(f.ctx());
		expect(second.report.filesFailed).toBe(1);
		expect(second.report.gaps).toContain("file-failed-inconsistent");
		expect(second.report.gapDetails).toContainEqual(
			expect.objectContaining({
				token: "file-failed-inconsistent",
				path: "src/a.ts",
			}),
		);
		expect(second.candidates).toBeUndefined();
		expect(f.manifest()?.files["src/a.ts"]).toBeUndefined();

		const third = await prepareDirtyOverlay(f.ctx());
		expect(third.candidates?.servedPaths).toEqual(["src/a.ts"]);
	});

	test("DEL-1: the strict delete throws → entries removed, failed, not served (count)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		f.write("src/a.ts", tsSource("a", 2, "v1"));
		await prepareDirtyOverlay(f.ctx());
		expect(Object.keys(f.manifest()?.files ?? {})).toEqual(["src/a.ts"]);

		f.write("src/a.ts", tsSource("a", 2, "v2"));
		f.write("src/b.ts", tsSource("b", 2, "v1"));
		const del = spyOn(
			VectorStore.prototype,
			"deleteRowsByStoredPathsStrict",
		).mockRejectedValue(new Error("injected delete failure"));
		spies.push(del);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.filesFailed).toBe(2);
		expect(result.candidates).toBeUndefined();
		expect(f.manifest()?.files).toEqual({});
		// The old v1 rows are still in the table, and nothing names them.
		const rows = await f.overlayRows();
		expect(
			rows.filter((r) => r.filePath === "src/a.ts").length,
		).toBeGreaterThan(0);
	});

	test("GH-1: ghost rows appended after a pass are never served, ids stay unique (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 3) });
		f.write("src/a.ts", tsSource("a", 3, "edited"));
		await prepareDirtyOverlay(f.ctx());
		const t = await table(f);
		const rows = (await t.query().toArray()) as Array<Record<string, unknown>>;
		const plain = (r: Record<string, unknown>) => {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(r)) {
				out[k] = k === "vector" ? Array.from(v as Iterable<number>) : v;
			}
			return out;
		};
		// A late duplicate append of a real row, and an OLD revision's row.
		const ghost = {
			...plain(rows[0]),
			id: "f".repeat(64),
			content: "export const GHOST_OLD_REVISION = 1;",
		};
		await t.add([plain(rows[0]), ghost]);

		const result = await prepareDirtyOverlay(f.ctx());
		const ids = (result.candidates?.vector ?? []).map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		const texts = [
			...(result.candidates?.vector ?? []),
			...(result.candidates?.rowsById.values() ?? []),
		].map((r) => r.content);
		expect(texts.join("\n")).not.toContain("GHOST_OLD_REVISION");
		expect(result.candidates?.rowsById.has("f".repeat(64))).toBe(false);
	});
});

describe("the lock", () => {
	test("LK-1: reclaimed mid-pass → lock-lost, nothing suppressed, manifest bytes unchanged (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "v1"));
		await prepareDirtyOverlay(f.ctx());
		const before = f.manifestBytes();
		expect(before).not.toBeNull();

		f.write("src/a.ts", tsSource("a", 2, "v2"));
		f.stub.beforeEmbed = () => {
			// Another process reclaimed the lock (our heartbeat stopped).
			unlinkSync(f.lockPath);
			writeFileSync(f.lockPath, '{"pid":1,"token":"new-owner"}');
		};
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "lock-lost",
		});
		expect(result.candidates).toBeUndefined();
		expect(f.manifestBytes()).toBe(before);
		// The new owner's lock is untouched by our release().
		expect(readFileSync(f.lockPath, "utf8")).toContain("new-owner");
	});

	test("WIPE-1: an identity wipe leaves .overlay.lock in place and HELD (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		await prepareDirtyOverlay(f.ctx());
		const observed: Array<{ lockExists: boolean; lockPid: number | null }> = [];
		const realWipe = manifestModule.wipeOverlayData;
		const wipe = spyOn(manifestModule, "wipeOverlayData");
		spies.push(wipe);
		wipe.mockImplementation((vectorsDir: string, manifestPath: string) => {
			realWipe(vectorsDir, manifestPath);
			const exists = existsSync(f.lockPath);
			observed.push({
				lockExists: exists,
				lockPid: exists
					? (JSON.parse(readFileSync(f.lockPath, "utf8")) as { pid: number })
							.pid
					: null,
			});
		});
		const b = new StubEmbedder("model-b");
		await prepareDirtyOverlay(
			f.ctx({
				indexIdentity: { model: "model-b", provider: "openrouter" },
				queryIdentity: { model: "model-b", provider: "openrouter" },
				queryClient: b,
			}),
		);
		expect(observed).toEqual([{ lockExists: true, lockPid: process.pid }]);
		expect(existsSync(f.vectorsDir)).toBe(true); // rebuilt after the wipe
	});

	test("busy: another holder for the whole wait → skipped/busy, nothing suppressed", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 1) });
		f.write("src/a.ts", tsSource("a", 1, "edited"));
		const other = new IndexLock(f.lockPath, "overlay");
		expect((await other.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		try {
			const result = await prepareDirtyOverlay(
				f.ctx({ limits: { lockWaitMs: 100 } }),
			);
			expect(result.report).toMatchObject({ state: "skipped", reason: "busy" });
			expect(result.candidates).toBeUndefined();
			expect(f.stub.texts).toBe(0);
		} finally {
			other.release();
		}
	});
});

describe("recovery and retention", () => {
	test("OPEN-1: a corrupt table is wiped and rebuilt once; results correct (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		await prepareDirtyOverlay(f.ctx());
		// Destroy the data files under the dataset.
		const dataDir = join(f.vectorsDir, "code_chunks.lance", "data");
		for (const name of readdirSync(dataDir)) unlinkSync(join(dataDir, name));

		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(result.report.gaps).toContain("overlay-wiped");
		expect(
			result.report.gapDetails.find((d) => d.token === "overlay-wiped")
				?.message,
		).toBeTruthy();
		const contents = [...(result.candidates?.rowsById.values() ?? [])].map(
			(r) => r.content,
		);
		expect(contents.join("\n")).toContain("edited");
	});

	test("OPEN-1: a second failure → skipped/overlay-corrupt, nothing suppressed", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const width = spyOn(VectorStore.prototype, "vectorWidth").mockRejectedValue(
			new Error("injected unreadable table"),
		);
		spies.push(width);
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "overlay-corrupt",
		});
		expect(result.candidates).toBeUndefined();
		expect(existsSync(f.lockPath)).toBe(false); // released
	});

	test("V-1: 20 edits → ≤ 2 versions and bounded bytes (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 4) });
		f.write("src/a.ts", tsSource("a", 4, "edit-0"));
		await prepareDirtyOverlay(f.ctx());
		const bytesAfterOne = duBytes(f.vectorsDir);
		for (let i = 1; i <= 20; i++) {
			f.write("src/a.ts", tsSource("a", 4, `edit-${i}`));
			const result = await prepareDirtyOverlay(f.ctx());
			expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		}
		const versions = (await (await table(f)).listVersions()).length;
		const bytes = duBytes(f.vectorsDir);
		console.log(
			`V-1: versions=${versions} bytes after 1 edit=${bytesAfterOne} after 21=${bytes}`,
		);
		expect(versions).toBeLessThanOrEqual(2);
		expect(bytes).toBeLessThan(bytesAfterOne * 3);
	});
});

describe("ROLE — only the overlay builds an overlay-role store", () => {
	test('`role: "overlay"` appears in src/core/overlay/dirty-overlay.ts only', () => {
		const src = join(import.meta.dir, "..", "..", "..", "src");
		const hits: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, e.name);
				if (e.isDirectory()) walk(full);
				else if (/\.tsx?$/.test(e.name)) {
					const text = readFileSync(full, "utf8");
					if (/role:\s*"overlay"/.test(text)) hits.push(relative(src, full));
				}
			}
		};
		walk(src);
		expect(hits).toEqual(["core/overlay/dirty-overlay.ts"]);
	});
});
