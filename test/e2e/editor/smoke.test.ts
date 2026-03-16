import { describe, test, expect, afterEach } from "bun:test";
import { TestWorkspace } from "../../helpers/test-workspace.js";

describe("TestWorkspace smoke test", () => {
	let ws: TestWorkspace;
	afterEach(() => ws?.cleanup());

	test("indexes a TypeScript function and finds the symbol", async () => {
		ws = TestWorkspace.create("smoke");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);

		const { graphManager } = await ws.index();
		const found = graphManager.findSymbol("add");

		expect(found).not.toBeNull();
		expect(found!.name).toBe("add");
		expect(found!.kind).toBe("function");
		expect(found!.filePath).toBe("src/math.ts");
	});
});
