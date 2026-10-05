/**
 * Integration tests for CodeUnitExtractor
 *
 * Tests:
 * - Hierarchical extraction (file -> class -> method)
 * - Parent-child KEY consistency (the critical bug we fixed)
 * - Multi-language support
 * - Metadata extraction
 *
 * SINCE DECISION I-14 A UNIT HAS TWO KEYS, and this suite joins on the right
 * one. `unit.id` is `codeUnitRowId` — position AND the unit's content hash, so
 * that two branches' revisions of one function are two rows. `unit.parentId` is
 * the parent's `codeUnitParentKey` — position only, so that an edit inside a
 * parent does not move the reference to it. They are different namespaces, and
 * every assertion below that used to read `parent.id` now reads
 * `codeUnitParentKeyOf(parent)`. Joining on `parent.id` makes every non-null
 * link dangle, which is what this suite would report.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CodeUnitExtractor,
	codeUnitParentKeyOf,
} from "../../src/core/ast/code-unit-extractor.js";
import type { CodeUnit } from "../../src/types.js";
import { samplePythonSource } from "../testdata/sample-python-source.ts";

const TESTDATA_DIR = join(import.meta.dir, "../testdata");

describe("CodeUnitExtractor", () => {
	let extractor: CodeUnitExtractor;

	beforeAll(async () => {
		// Parser manager initializes lazily, just create the extractor
		extractor = new CodeUnitExtractor();
	});

	describe("TypeScript extraction", () => {
		let units: CodeUnit[];
		const filePath = "test/testdata/sample-typescript.ts";

		beforeAll(async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			units = await extractor.extractUnits(
				source,
				filePath,
				"typescript",
				fileHash,
			);
		});

		test("extracts file-level unit", () => {
			const fileUnit = units.find((u) => u.unitType === "file");
			expect(fileUnit).toBeDefined();
			expect(fileUnit?.parentId).toBeNull();
			expect(fileUnit?.depth).toBe(0);
			expect(fileUnit?.name).toBe("sample-typescript.ts");
		});

		test("extracts class with correct hierarchy", () => {
			const fileUnit = units.find((u) => u.unitType === "file");
			const classUnit = units.find(
				(u) => u.unitType === "class" && u.name === "UserService",
			);

			expect(classUnit).toBeDefined();
			expect(classUnit?.parentId).toBe(
				fileUnit ? codeUnitParentKeyOf(fileUnit) : "",
			);
			expect(classUnit?.depth).toBe(1);
		});

		test("extracts methods as children of class", () => {
			const classUnit = units.find(
				(u) => u.unitType === "class" && u.name === "UserService",
			);
			const classKey = classUnit ? codeUnitParentKeyOf(classUnit) : "";
			const methods = units.filter(
				(u) => u.unitType === "method" && u.parentId === classKey,
			);

			expect(methods.length).toBeGreaterThanOrEqual(4); // createUser, getUser, deleteUser, listUsers
			expect(methods.every((m) => m.depth === 2)).toBe(true);

			const methodNames = methods.map((m) => m.name);
			expect(methodNames).toContain("createUser");
			expect(methodNames).toContain("getUser");
			expect(methodNames).toContain("deleteUser");
			expect(methodNames).toContain("listUsers");
		});

		test("extracts standalone functions", () => {
			const validateEmail = units.find(
				(u) => u.unitType === "function" && u.name === "validateEmail",
			);
			const fileUnit = units.find((u) => u.unitType === "file");

			expect(validateEmail).toBeDefined();
			expect(validateEmail?.parentId).toBe(
				fileUnit ? codeUnitParentKeyOf(fileUnit) : "",
			);
			expect(validateEmail?.depth).toBe(1);
		});

		test("extracts interface", () => {
			const userInterface = units.find(
				(u) => u.unitType === "interface" && u.name === "User",
			);
			expect(userInterface).toBeDefined();
		});

		test("extracts type alias", () => {
			const typeAlias = units.find(
				(u) => u.unitType === "type" && u.name === "UserRole",
			);
			expect(typeAlias).toBeDefined();
		});

		test("extracts async metadata", () => {
			const createUser = units.find((u) => u.name === "createUser");
			expect(createUser?.metadata?.isAsync).toBe(true);

			const getUser = units.find((u) => u.name === "getUser");
			expect(getUser?.metadata?.isAsync).toBeFalsy(); // Not async
		});

		test("extracts exported status", () => {
			const userService = units.find((u) => u.name === "UserService");
			expect(userService?.metadata?.isExported).toBe(true);

			const generateAuditLog = units.find((u) => u.name === "generateAuditLog");
			// Internal function - not exported
			expect(generateAuditLog?.metadata?.isExported).toBeFalsy();
		});
	});

	describe("Parent-child KEY consistency", () => {
		test("child parentId matches the parent's POSITION KEY exactly", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			// Build a map of all unit POSITION KEYS — the namespace a link lives
			// in. A set of `u.id` here would be empty of every link (I-14).
			const unitKeys = new Set(units.map(codeUnitParentKeyOf));

			// Check that every non-null parentId exists in the unit set
			for (const unit of units) {
				if (unit.parentId !== null) {
					expect(unitKeys.has(unit.parentId)).toBe(true);
				}
			}
		});

		test("hierarchy depth is consistent", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			const unitMap = new Map(units.map((u) => [codeUnitParentKeyOf(u), u]));

			for (const unit of units) {
				if (unit.parentId !== null) {
					const parent = unitMap.get(unit.parentId);
					expect(parent).toBeDefined();
					if (!parent) {
						throw new Error(`Expected parent unit ${unit.parentId} to exist`);
					}
					expect(unit.depth).toBe(parent.depth + 1);
				}
			}
		});

		test("getChildren returns correct children", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			const classUnit = units.find(
				(u) => u.unitType === "class" && u.name === "UserService",
			);
			expect(classUnit).toBeDefined();
			if (!classUnit) {
				throw new Error("Expected UserService class unit to exist");
			}

			const classKey = codeUnitParentKeyOf(classUnit);
			const children = extractor.getChildren(units, classKey);
			expect(children.length).toBeGreaterThan(0);
			expect(children.every((c) => c.parentId === classKey)).toBe(true);
			// Non-vacuity against the namespace mistake: passing the ROW id here
			// returns nothing, which is why `getChildren` documents its argument.
			expect(extractor.getChildren(units, classUnit.id)).toEqual([]);
		});
	});

	describe("Python extraction", () => {
		let units: CodeUnit[];
		const filePath = "test/testdata/sample-python.py";

		beforeAll(async () => {
			const source = samplePythonSource;
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			units = await extractor.extractUnits(
				source,
				filePath,
				"python",
				fileHash,
			);
		});

		test("extracts Python class", () => {
			const productRepo = units.find(
				(u) => u.unitType === "class" && u.name === "ProductRepository",
			);
			expect(productRepo).toBeDefined();
		});

		test("extracts Python methods with correct parent", () => {
			const productRepo = units.find(
				(u) => u.unitType === "class" && u.name === "ProductRepository",
			);
			const repoKey = productRepo ? codeUnitParentKeyOf(productRepo) : "";
			const methods = units.filter(
				(u) => u.unitType === "method" && u.parentId === repoKey,
			);

			const methodNames = methods.map((m) => m.name);
			expect(methodNames).toContain("find_by_id");
			expect(methodNames).toContain("save");
			expect(methodNames).toContain("find_by_category");
		});

		test("detects Python visibility by naming convention", () => {
			const invalidateCache = units.find((u) => u.name === "_invalidate_cache");
			expect(invalidateCache).toBeDefined();
			// Python underscore prefix = protected
			expect(invalidateCache?.metadata?.visibility).toBe("protected");
		});

		test("extracts async Python function", () => {
			const calculateDiscount = units.find(
				(u) => u.name === "calculate_discount",
			);
			expect(calculateDiscount).toBeDefined();
			expect(calculateDiscount?.metadata?.isAsync).toBe(true);
		});

		test("extracts dataclass", () => {
			const product = units.find(
				(u) => u.unitType === "class" && u.name === "Product",
			);
			expect(product).toBeDefined();
		});
	});

	describe("Go extraction", () => {
		let units: CodeUnit[];
		const filePath = "test/testdata/sample-go.go";

		beforeAll(async () => {
			const source = readFileSync(join(TESTDATA_DIR, "sample-go.go"), "utf-8");
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			units = await extractor.extractUnits(source, filePath, "go", fileHash);
		});

		test("extracts Go struct as class", () => {
			const memoryStore = units.find(
				(u) => u.unitType === "class" && u.name?.includes("MemoryStore"),
			);
			expect(memoryStore).toBeDefined();
		});

		test("extracts Go interface", () => {
			const storeInterface = units.find(
				(u) => u.unitType === "interface" && u.name === "Store",
			);
			expect(storeInterface).toBeDefined();
		});

		test("extracts Go functions", () => {
			const newMemoryStore = units.find(
				(u) => u.unitType === "function" && u.name === "NewMemoryStore",
			);
			expect(newMemoryStore).toBeDefined();
		});

		test("detects Go exported status by capitalization", () => {
			const processItems = units.find((u) => u.name === "ProcessItems");
			expect(processItems).toBeDefined();
			expect(processItems?.metadata?.isExported).toBe(true);

			const helper = units.find((u) => u.name === "helper");
			expect(helper).toBeDefined();
			expect(helper?.metadata?.isExported).toBeFalsy();
		});
	});

	describe("Helper methods", () => {
		test("sortByDepthDesc returns deepest units first", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			const sorted = extractor.sortByDepthDesc(units);

			// First units should be deepest (methods at depth 2)
			expect(sorted[0].depth).toBeGreaterThanOrEqual(
				sorted[sorted.length - 1].depth,
			);
		});

		test("getMaxDepth returns correct value", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			const maxDepth = extractor.getMaxDepth(units);
			// file(0) -> class(1) -> method(2), but nested functions can go deeper
			expect(maxDepth).toBeGreaterThanOrEqual(2);
		});

		test("getUnitsAtDepth filters correctly", async () => {
			const source = readFileSync(
				join(TESTDATA_DIR, "sample-typescript.ts"),
				"utf-8",
			);
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/sample.ts",
				"typescript",
				fileHash,
			);

			const depth1Units = extractor.getUnitsAtDepth(units, 1);
			expect(depth1Units.every((u) => u.depth === 1)).toBe(true);

			const depth0Units = extractor.getUnitsAtDepth(units, 0);
			expect(depth0Units.length).toBe(1);
			expect(depth0Units[0].unitType).toBe("file");
		});
	});

	describe("Edge cases", () => {
		test("handles empty file", async () => {
			const units = await extractor.extractUnits(
				"",
				"test/empty.ts",
				"typescript",
				"abcd1234",
			);
			expect(units.length).toBe(1); // Just the file unit
			expect(units[0].unitType).toBe("file");
		});

		test("handles file with only comments", async () => {
			const source = `
				// This is a comment
				/* Block comment */
			`;
			const units = await extractor.extractUnits(
				source,
				"test/comments.ts",
				"typescript",
				"abcd1234",
			);
			expect(units.length).toBe(1); // Just the file unit
		});

		test("handles deeply nested code", async () => {
			const source = `
				export class Outer {
					inner() {
						const nested = () => {
							return () => {
								console.log("deep");
							};
						};
					}
				}
			`;
			const fileHash = createHash("sha256")
				.update(source)
				.digest("hex")
				.slice(0, 16);
			const units = await extractor.extractUnits(
				source,
				"test/nested.ts",
				"typescript",
				fileHash,
			);

			// Should have file, class, method at minimum
			expect(units.length).toBeGreaterThanOrEqual(3);
		});

		test("handles syntax errors gracefully", async () => {
			const source = `
				export class Broken {
					method( { // Missing closing
				}
			`;
			// Should not throw, should return at least file unit
			const units = await extractor.extractUnits(
				source,
				"test/broken.ts",
				"typescript",
				"abcd1234",
			);
			expect(units.length).toBeGreaterThanOrEqual(1);
		});
	});
});
