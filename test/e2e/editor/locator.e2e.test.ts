import { describe, test, expect, afterEach } from "bun:test";
import { TestWorkspace } from "../../helpers/test-workspace.js";
import { SymbolLocator } from "../../../src/editor/locator.js";

describe("SymbolLocator E2E", () => {
	let ws: TestWorkspace;
	afterEach(() => ws?.cleanup());

	test("locate: finds exported function by name", async () => {
		ws = TestWorkspace.create("locator-basic");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);
		await ws.index();

		const { graphManager, tracker } = await ws.getCache().get();
		const locator = new SymbolLocator(graphManager, tracker);

		const result = locator.locate("add");
		expect(result).not.toBeNull();
		expect(result!.filePath).toBe("src/math.ts");
		expect(result!.source).toBe("tree-sitter");
		expect(result!.symbol.isExported).toBe(true);
	});

	test("locate: returns null for unknown symbol", async () => {
		ws = TestWorkspace.create("locator-missing");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);
		await ws.index();

		const { graphManager, tracker } = await ws.getCache().get();
		const locator = new SymbolLocator(graphManager, tracker);

		const result = locator.locate("nonExistent");
		expect(result).toBeNull();
	});

	test("locateByFile: lists all symbols in a file", async () => {
		ws = TestWorkspace.create("locator-byfile");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;") +
				"\n" +
				TestWorkspace.tsFunction("subtract", "return a - b;"),
		);
		await ws.index();

		const { graphManager, tracker } = await ws.getCache().get();
		const locator = new SymbolLocator(graphManager, tracker);

		const results = locator.locateByFile("src/math.ts");
		expect(results.length).toBeGreaterThanOrEqual(2);
		const names = results.map((r) => r.symbol.name);
		expect(names).toContain("add");
		expect(names).toContain("subtract");
	});
});
