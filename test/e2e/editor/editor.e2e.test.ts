import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestWorkspace } from "../../helpers/test-workspace.js";

describe("SymbolEditor E2E", () => {
  let ws: TestWorkspace;

  afterEach(() => ws?.cleanup());

  // FR-1.1: editSymbol replace
  test("editSymbol replace: writes new body to disk", async () => {
    ws = TestWorkspace.create("editor-replace");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    const result = await editor.editSymbol(
      "add",
      "export function add(a: number, b: number): number {\n  return a * b;\n}\n",
      "replace",
    );

    expect(result.dryRun).toBe(false);
    expect(result.symbolName).toBe("add");

    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("return a * b;");
    expect(content).not.toContain("return a + b;");
  });

  // FR-1.1: editSymbol insert before
  test("editSymbol before: prepends content before symbol", async () => {
    ws = TestWorkspace.create("editor-before");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    await editor.editSymbol("add", "// This is a comment before add\n", "before");

    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("// This is a comment before add");
    expect(content).toContain("return a + b;"); // original still present
  });

  // FR-1.1: editSymbol insert after
  test("editSymbol after: appends content after symbol", async () => {
    ws = TestWorkspace.create("editor-after");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    await editor.editSymbol(
      "add",
      "\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n",
      "after",
    );

    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("return a + b;"); // original still present
    expect(content).toContain("return a - b;"); // new content appended
  });

  // FR-1.2: editLines
  test("editLines: replaces line range correctly", async () => {
    ws = TestWorkspace.create("editor-lines");
    // Use valid TypeScript — each "line" is a const declaration
    const fileContent = [
      "export const a = 1;",
      "export const b = 2;",
      "export const c = 3;",
      "export const d = 4;",
      "export const e = 5;",
      "",
    ].join("\n");
    ws.writeFile("src/file.ts", fileContent);
    await ws.index();
    const editor = ws.createEditor();

    const absPath = join(ws.root, "src/file.ts");
    // Replace lines 2-3 (b and c) with two new const declarations
    await editor.editLines(
      absPath,
      2,
      3,
      "export const x = 10;\nexport const y = 20;",
    );

    const result = readFileSync(absPath, "utf-8");
    expect(result).toContain("const a = 1");
    expect(result).toContain("const x = 10");
    expect(result).toContain("const y = 20");
    expect(result).toContain("const d = 4");
    expect(result).not.toContain("const b = 2");
    expect(result).not.toContain("const c = 3");
  });

  // FR-1.3: dryRun mode
  test("dryRun: returns metadata without writing", async () => {
    ws = TestWorkspace.create("editor-dryrun");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    const result = await editor.editSymbol("add", "// new content", "replace", { dryRun: true });

    expect(result.dryRun).toBe(true);

    // File should NOT be modified
    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("return a + b;");
  });

  // FR-1.4: syntax validation (tree-sitter reject)
  test("syntaxCheck: rejects invalid TypeScript", async () => {
    ws = TestWorkspace.create("editor-syntax");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    // This should throw because the replacement creates invalid syntax
    await expect(
      editor.editSymbol(
        "add",
        "export function add(a: number, b: number): number { {{{ invalid",
        "replace",
      ),
    ).rejects.toThrow(/[Ss]yntax/);

    // File should NOT be modified
    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("return a + b;");
  });

  // FR-1.5: path traversal guard
  test("preCheck: blocks path traversal", async () => {
    ws = TestWorkspace.create("editor-traversal");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    await expect(
      editor.editLines("/etc/passwd", 1, 1, "hacked"),
    ).rejects.toThrow(/[Pp]ath|traversal|outside/);
  });

  // FR-1.6: size limit guard
  test("sizeCheck: rejects content over 1MB", async () => {
    ws = TestWorkspace.create("editor-size");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    const hugeContent = "x".repeat(1_100_000);

    await expect(
      editor.editSymbol("add", hugeContent, "replace"),
    ).rejects.toThrow(/too large|limit|1.*MB/i);
  });

  // FR-1.7: history backup
  test("history: backup is created and restore works", async () => {
    ws = TestWorkspace.create("editor-history");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    const originalContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");

    // Edit
    const result = await editor.editSymbol(
      "add",
      "export function add(a: number, b: number): number {\n  return a * b;\n}\n",
      "replace",
    );

    // Verify edited
    const editedContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(editedContent).toContain("return a * b;");

    // Restore
    const restored = await editor.restoreSession(result.sessionId);
    expect(restored.length).toBeGreaterThan(0);

    // Verify restored
    const restoredContent = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(restoredContent).toBe(originalContent);
  });

  // FR-1.8: symbol not found
  test("editSymbol: throws for unknown symbol", async () => {
    ws = TestWorkspace.create("editor-notfound");
    ws.writeFile("src/math.ts", TestWorkspace.tsFunction("add", "return a + b;"));
    await ws.index();
    const editor = ws.createEditor();

    await expect(
      editor.editSymbol("nonExistentSymbol", "// new", "replace"),
    ).rejects.toThrow(/not found/);
  });

  // FR-1.9: multiple symbols
  test("editSymbol: handles multiple symbols in same file", async () => {
    ws = TestWorkspace.create("editor-multi");
    ws.writeFile(
      "src/math.ts",
      TestWorkspace.tsFunction("add", "return a + b;") +
        "\n" +
        TestWorkspace.tsFunction("multiply", "return a * b;"),
    );
    await ws.index();
    const editor = ws.createEditor();

    // Edit only 'add', 'multiply' should remain unchanged
    await editor.editSymbol(
      "add",
      "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n",
      "replace",
    );

    const content = readFileSync(join(ws.root, "src/math.ts"), "utf-8");
    expect(content).toContain("return a + b + 1;");
    expect(content).toContain("return a * b;");
  });
});
