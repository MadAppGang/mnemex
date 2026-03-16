// test/e2e/scenarios/edit-restore.e2e.test.ts
//
// FR-4.2: Full edit → verify disk change → restore → verify disk restored.
// These are cross-cutting scenario tests that exercise real indexing +
// SymbolEditor edit and restore together.

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestWorkspace } from "../../helpers/test-workspace.js";

describe("Edit-Restore Scenarios (FR-4.2)", () => {
	let ws: TestWorkspace;

	afterEach(() => ws?.cleanup());

	test("edit then restore: full round-trip with disk verification", async () => {
		ws = TestWorkspace.create("scenario-edit-restore");

		// Write a function with a known body
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);

		// Capture the original file content before any edit
		const originalContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(originalContent).toContain("return a + b;");

		// Index the workspace with the real in-process pipeline
		await ws.index();
		const editor = ws.createEditor();

		// Edit the function body (replace addition with multiplication)
		const result = await editor.editSymbol(
			"add",
			"export function add(a: number, b: number): number {\n  return a * b;\n}\n",
			"replace",
		);

		expect(result.dryRun).toBe(false);
		expect(result.symbolName).toBe("add");
		expect(result.sessionId).toBeTruthy();

		// Verify the change is reflected on disk
		const editedContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(editedContent).toContain("return a * b;");
		expect(editedContent).not.toContain("return a + b;");

		// Restore the session
		const restoredFiles = await editor.restoreSession(result.sessionId);
		expect(restoredFiles.length).toBeGreaterThan(0);

		// Verify the file on disk matches the original content
		const restoredContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(restoredContent).toBe(originalContent);
		expect(restoredContent).toContain("return a + b;");
		expect(restoredContent).not.toContain("return a * b;");
	});

	test("multiple edits then restore: restores to pre-session state", async () => {
		ws = TestWorkspace.create("scenario-multi-edit-restore");

		// Write two functions
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;") +
				"\n" +
				TestWorkspace.tsFunction("multiply", "return a * b;"),
		);

		// Capture original disk content
		const originalContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(originalContent).toContain("return a + b;");
		expect(originalContent).toContain("return a * b;");

		// Index with the real pipeline
		await ws.index();
		const editor = ws.createEditor();

		// Edit "add" — changes its body on disk
		const result1 = await editor.editSymbol(
			"add",
			"export function add(a: number, b: number): number {\n  return a - b;\n}\n",
			"replace",
		);

		expect(result1.symbolName).toBe("add");

		// Verify "add" changed on disk, "multiply" is untouched
		const afterFirstEdit = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(afterFirstEdit).toContain("return a - b;");
		expect(afterFirstEdit).not.toContain("return a + b;");
		expect(afterFirstEdit).toContain("return a * b;");

		// Restore the "add" edit session
		const restoredFiles = await editor.restoreSession(result1.sessionId);
		expect(restoredFiles.length).toBeGreaterThan(0);

		// Verify "add" is restored to its original state
		const afterRestore = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
		expect(afterRestore).toContain("return a + b;");
		expect(afterRestore).not.toContain("return a - b;");

		// "multiply" should still be present and unchanged
		expect(afterRestore).toContain("return a * b;");

		// Full file should match original
		expect(afterRestore).toBe(originalContent);
	});
});
