/**
 * The float32 codec, and the ASSUMPTION it rests on (§4.3, §11 assumption 1).
 *
 * The soundness argument for storing 4 bytes per dimension instead of 8 is that
 * LanceDB's JS client infers `FixedSizeList<Float32>` for a `number[]` vector
 * column, so a JS float64 that reaches `addChunks` is narrowed to f32 BY LANCEDB
 * ANYWAY. Round-tripping f64 -> f32 -> f64 through the cache therefore yields a
 * value that narrows to the IDENTICAL f32 in the table: same bytes on disk, same
 * distances, same ranking.
 *
 * That is an assumption about a third-party library's schema inference, so it is
 * FALSIFIED here rather than trusted — the test reads the Arrow schema of a real
 * table. If it ever fails, the fallback is float64 (`bytes` doubles, capacity
 * halves) behind the `meta.vector_encoding` flag, not a redesign.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	decodeVectorF32,
	encodeVectorF32,
	toBlobParam,
} from "../../../src/core/embed-cache.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-codec-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("float32 codec", () => {
	test("encodes 4 bytes per dimension, little-endian", () => {
		const bytes = encodeVectorF32([1.5, -2.25, 3.125]);
		expect(bytes.byteLength).toBe(12);
		// 1.5 as IEEE-754 binary32 is 0x3FC00000; little-endian => 00 00 C0 3F.
		expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x00, 0xc0, 0x3f]);
	});

	test("round-trips exactly for values representable in f32", () => {
		// Every value here is exactly representable in binary32, so the round trip
		// must be bit-exact rather than merely close.
		const v = [0, 1, -1, 1.5, -2.25, 3.125, 0.5, 2 ** -20, 65504];
		expect(decodeVectorF32(encodeVectorF32(v))).toEqual(v);
	});

	test("a f64 narrows to the SAME f32 the table would store", () => {
		// The whole soundness argument in one assertion: Math.fround is idempotent,
		// so f32(f64) === f32(f32(f64)).
		const v = [0.1, 0.2, 0.30000000000000004, Math.PI, Math.E];
		const round = decodeVectorF32(encodeVectorF32(v));
		expect(round).toEqual(v.map((x) => Math.fround(x)));
		expect(decodeVectorF32(encodeVectorF32(round))).toEqual(round);
	});

	test("an empty vector encodes to zero bytes — which is why it is never stored", () => {
		// CLAUDE.md #15. The codec itself is honest about it; the refusal lives at
		// both boundaries of the cache, compared against `0` explicitly.
		expect(encodeVectorF32([]).byteLength).toBe(0);
		expect(decodeVectorF32(new Uint8Array(0))).toEqual([]);
	});

	test("a misaligned blob still decodes (drivers hand back arbitrary views)", () => {
		const backing = new Uint8Array(13);
		backing.set(encodeVectorF32([1.5, -2.25, 3.125]), 1);
		const view = backing.subarray(1); // byteOffset 1 — not 4-byte aligned
		expect(decodeVectorF32(view)).toEqual([1.5, -2.25, 3.125]);
	});

	test("a blob that is not float32-aligned is refused, not silently truncated", () => {
		expect(() => decodeVectorF32(new Uint8Array(7))).toThrow(
			/not float32-aligned/,
		);
	});

	test("toBlobParam preserves the bytes on this runtime", () => {
		const bytes = encodeVectorF32([1.5, -2.25, 3.125]);
		const param = toBlobParam(bytes);
		expect(param.byteLength).toBe(bytes.byteLength);
		expect(Array.from(param)).toEqual(Array.from(bytes));
	});
});

describe("ASSUMPTION 1 — LanceDB stores the vector column as Float32", () => {
	test("a created table's vector field is FixedSizeList<Float32>", async () => {
		const db = await lancedb.connect(join(dir, "lance"));
		const table = await db.createTable("t", [
			{ id: "a", vector: [0.1, 0.2, 0.3], embedKey: "k" },
		]);
		const schema = await table.schema();
		const field = schema.fields.find(
			(f: { name: string }) => f.name === "vector",
		);
		expect(field).toBeDefined();
		expect(String(field?.type)).toBe("FixedSizeList[3]<Float32>");

		const type = field?.type as unknown as {
			listSize: number;
			children: Array<{ type: unknown }>;
		};
		expect(type.listSize).toBe(3);
		expect(String(type.children[0]?.type)).toBe("Float32");
	});
});
