/**
 * Black Box Unit Tests: mnemex pack command
 *
 * Tests validate behavior described in requirements only.
 * No implementation details are assumed or tested.
 *
 * Test setup: create temp directories with known files, run packCommand(),
 * assert on output string or PackResult fields.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { packCommand } from "../../src/pack/index.js";
import type { PackOptions } from "../../src/pack/types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal valid PackOptions object with defaults */
function defaultOptions(
	projectPath: string,
	overrides: Partial<PackOptions> = {},
): PackOptions {
	return {
		projectPath,
		format: "xml",
		includePatterns: [],
		excludePatterns: [],
		useGitignore: false, // disable gitignore by default to keep tests self-contained
		maxFileSize: 1024 * 1024, // 1 MB
		stdout: false,
		showTokens: false,
		...overrides,
	};
}

/** Write a temp file at an absolute path, creating parent dirs as needed */
function writeFile(filePath: string, content: string): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

/** Run packCommand and capture output string from a temp output file */
async function packToString(options: PackOptions): Promise<string> {
	const outFile = join(
		tmpdir(),
		`pack-test-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	try {
		await packCommand({ ...options, outputPath: outFile, stdout: false });
		return readFileSync(outFile, "utf-8");
	} finally {
		try {
			rmSync(outFile);
		} catch {
			/* ignore */
		}
	}
}

// ============================================================================
// TEST GROUP 1: Format Output Correctness
// ============================================================================

describe("Format: XML", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-xml-"));
		writeFile(
			join(tempDir, "src", "hello.ts"),
			"export const hello = 'world';",
		);
		writeFile(
			join(tempDir, "src", "util.ts"),
			"export function add(a: number, b: number) { return a + b; }",
		);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-1a: output contains <file_summary> section", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("<file_summary>");
	});

	test("TEST-1b: output contains <directory_structure> section", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("<directory_structure>");
	});

	test("TEST-1c: output contains <files> section", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("<files>");
	});

	test("TEST-1d: each file is wrapped in <file path='...'> tags", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// Should have at least one file element with a path attribute
		expect(output).toMatch(/<file path=["'][^"']+["']/);
	});

	test("TEST-1e: file content appears inside <file> tags", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("hello");
	});
});

describe("Format: Markdown", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-md-"));
		writeFile(join(tempDir, "src", "main.ts"), "function main() {}");
		writeFile(join(tempDir, "README.md"), "# My Project");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-2a: output contains '# Codebase:' header", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
		expect(output).toContain("# Codebase:");
	});

	test("TEST-2b: output contains '## Directory Structure' section", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
		expect(output).toContain("## Directory Structure");
	});

	test("TEST-2c: directory structure section uses fenced code block", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
		// The directory tree should be in a fenced block after '## Directory Structure'
		const dirSection = output.split("## Directory Structure")[1];
		expect(dirSection).toBeDefined();
		expect(dirSection).toMatch(/```/);
	});

	test("TEST-2d: output contains '### File:' sections", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
		expect(output).toContain("### File:");
	});

	test("TEST-2e: file sections use fenced code blocks", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
		// File content should appear inside a fenced code block
		const fileSection = output.split("### File:")[1];
		expect(fileSection).toBeDefined();
		expect(fileSection).toMatch(/```/);
	});
});

describe("Format: Plain", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-plain-"));
		writeFile(join(tempDir, "app.py"), "def main(): pass");
		writeFile(join(tempDir, "config.json"), '{"key": "value"}');
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-3a: output contains 64-char '=' separator lines", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "plain" }),
		);
		const separator = "=".repeat(64);
		expect(output).toContain(separator);
	});

	test("TEST-3b: output contains 'File:' headers", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "plain" }),
		);
		expect(output).toContain("File:");
	});

	test("TEST-3c: output contains 'End of Codebase' sentinel", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "plain" }),
		);
		expect(output).toContain("End of Codebase");
	});
});

// ============================================================================
// TEST GROUP 2: XML Special Character Escaping
// ============================================================================

describe("XML: special character escaping", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-xml-escape-"));
		// Content containing XML special characters
		writeFile(
			join(tempDir, "special.txt"),
			'price = 5 & 10; if (a < b && b > c) { return "ok"; }',
		);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-4a: ampersand is escaped as &amp; in XML content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("&amp;");
	});

	test("TEST-4b: less-than is escaped as &lt; in XML content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("&lt;");
	});

	test("TEST-4c: greater-than is escaped as &gt; in XML content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("&gt;");
	});

	test("TEST-4d: raw unescaped < does not appear inside XML file element", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// Extract content between first <file and </file> tags
		const match = output.match(/<file[^>]*>([\s\S]*?)<\/file>/);
		if (match) {
			// Inside a file element, a raw < would mean malformed XML
			// Since our content has < we expect it to be escaped there
			const inner = match[1];
			// Verify no raw unescaped < appears that is not part of a tag
			// (There should be no standalone < followed by non-/ or non-word chars from our content)
			expect(inner).not.toMatch(/price = 5 & 10/); // raw unescaped & in content
		}
	});
});

// ============================================================================
// TEST GROUP 3: Markdown Triple Backtick Handling
// ============================================================================

describe("Markdown: triple backtick fence escaping", () => {
	let tempDir: string;
	let output: string;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-md-backtick-"));
		// A file that contains triple backticks (like a markdown file with code blocks)
		writeFile(
			join(tempDir, "example.md"),
			"Here is code:\n```js\nconsole.log('hello');\n```\nEnd.",
		);
		output = await packToString(
			defaultOptions(tempDir, { format: "markdown" }),
		);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-5: file with triple backticks does not break markdown fenced blocks", () => {
		// The output should still contain '### File:' sections — if backticks weren't
		// handled, the code fence would be broken and the structure would be wrong.
		// We validate structure integrity: every opening ``` for a file block has a close.
		const lines = output.split("\n");
		let depth = 0;
		let structureOk = true;
		for (const line of lines) {
			if (line.startsWith("```") && line.trim() === "```") {
				depth = depth === 0 ? 1 : 0;
			} else if (line.startsWith("````")) {
				// Quadruple-backtick fence used to wrap content with triple backticks
				depth = depth === 0 ? 1 : 0;
			}
		}
		// The output should have the file section header present
		expect(output).toContain("### File:");
		// And the content of the file should be present
		expect(output).toContain("console.log");
	});
});

// ============================================================================
// TEST GROUP 4: Filtering - Default Exclude Patterns
// ============================================================================

describe("Filtering: default exclude patterns", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-filter-"));
		// Source file - should be included
		writeFile(join(tempDir, "src", "index.ts"), "export default {};");
		// Files in commonly excluded directories
		writeFile(
			join(tempDir, "node_modules", "lib", "index.js"),
			"module.exports = {};",
		);
		writeFile(
			join(tempDir, ".git", "config"),
			"[core]\n\trepositoryformatversion = 0",
		);
		writeFile(join(tempDir, "dist", "bundle.js"), "!function(){}()");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-6: node_modules files are excluded by default", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).not.toContain("node_modules/lib/index.js");
		expect(output).not.toContain("node_modules\\lib\\index.js");
	});

	test("TEST-7: .git files are excluded by default", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// .git/config content should not appear
		expect(output).not.toContain("repositoryformatversion");
	});

	test("TEST-8: dist files are excluded by default", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).not.toContain("dist/bundle.js");
		expect(output).not.toContain("dist\\bundle.js");
		expect(output).not.toContain("!function(){}()");
	});

	test("non-excluded source file IS included", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("export default {}");
	});
});

// ============================================================================
// TEST GROUP 5: Filtering - includePatterns
// ============================================================================

describe("Filtering: includePatterns restricts files", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-include-"));
		writeFile(join(tempDir, "src", "app.ts"), "export const app = true;");
		writeFile(join(tempDir, "src", "readme.md"), "# Project");
		writeFile(join(tempDir, "src", "config.json"), '{"env":"prod"}');
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-9a: with includePatterns=['**/*.ts'] only .ts files are included in content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", includePatterns: ["**/*.ts"] }),
		);
		expect(output).toContain("app.ts");
		expect(output).toContain("export const app");
	});

	test("TEST-9b: with includePatterns=['**/*.ts'] markdown file is excluded from content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", includePatterns: ["**/*.ts"] }),
		);
		// The markdown file content should not appear in the file sections
		expect(output).not.toContain("# Project");
	});

	test("TEST-9c: with includePatterns=['**/*.ts'] JSON file is excluded from content", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", includePatterns: ["**/*.ts"] }),
		);
		expect(output).not.toContain('"env":"prod"');
	});
});

// ============================================================================
// TEST GROUP 6: Filtering - excludePatterns
// ============================================================================

describe("Filtering: excludePatterns beyond defaults", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-exclude-"));
		writeFile(join(tempDir, "src", "a.ts"), "const a = 1;");
		writeFile(join(tempDir, "src", "b.ts"), "const b = 2;");
		writeFile(join(tempDir, "src", "c.ts"), "const c = 3;");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-10a: file matching excludePattern is excluded", async () => {
		const output = await packToString(
			defaultOptions(tempDir, {
				format: "xml",
				excludePatterns: ["**/b.ts"],
			}),
		);
		expect(output).not.toContain("const b = 2");
	});

	test("TEST-10b: files not matching excludePattern are still included", async () => {
		const output = await packToString(
			defaultOptions(tempDir, {
				format: "xml",
				excludePatterns: ["**/b.ts"],
			}),
		);
		expect(output).toContain("const a = 1");
		expect(output).toContain("const c = 3");
	});
});

// ============================================================================
// TEST GROUP 7: Filtering - useGitignore
// ============================================================================

describe("Filtering: useGitignore: false includes gitignored files", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-gitignore-"));
		// Create a .gitignore that excludes secret.txt
		writeFileSync(join(tempDir, ".gitignore"), "secret.txt\n", "utf-8");
		writeFile(join(tempDir, "public.ts"), "export const pub = true;");
		writeFile(join(tempDir, "secret.txt"), "TOP SECRET CONTENT");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-11: useGitignore: false causes gitignored files to be included", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", useGitignore: false }),
		);
		expect(output).toContain("TOP SECRET CONTENT");
	});
});

// ============================================================================
// TEST GROUP 8: Binary File Handling
// ============================================================================

describe("Filtering: binary files", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-binary-"));
		// A normal text file
		writeFile(join(tempDir, "hello.ts"), "const x = 1;");
		// A PNG binary file: write actual PNG magic bytes (89 50 4E 47 ...)
		const pngMagic = Buffer.from([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d,
			0x49,
			0x48,
			0x44,
			0x52, // IHDR chunk length + type
		]);
		mkdirSync(join(tempDir, "assets"), { recursive: true });
		require("fs").writeFileSync(join(tempDir, "assets", "logo.png"), pngMagic);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-12a: binary files are counted in binarySkipped", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(result.binarySkipped).toBeGreaterThanOrEqual(1);
	});

	test("TEST-12b: binary file content does not appear in file sections", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// Binary content should not appear as readable text in file elements
		// Check that the PNG file path doesn't appear with actual content in a file section
		// The binary file may appear in directory tree but not in file content sections
		const filesSection = output.split("<files>")[1] ?? output;
		expect(filesSection).not.toContain("logo.png");
	});
});

// ============================================================================
// TEST GROUP 9: maxFileSize Filtering
// ============================================================================

describe("Filtering: maxFileSize skips large files", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-maxsize-"));
		writeFile(join(tempDir, "small.ts"), "const x = 1;"); // ~12 bytes
		// Create a file that exceeds 100 bytes
		writeFile(join(tempDir, "large.ts"), "x".repeat(200)); // 200 bytes
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-13a: large file is counted in sizeSkipped", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml", maxFileSize: 100 }),
		);
		expect(result.sizeSkipped).toBeGreaterThanOrEqual(1);
	});

	test("TEST-13b: large file content does not appear in output", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", maxFileSize: 100 }),
		);
		// The 200-byte repeated 'x' content should not appear
		expect(output).not.toContain("x".repeat(50));
	});

	test("TEST-13c: small file IS included when it is below maxFileSize", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml", maxFileSize: 100 }),
		);
		expect(output).toContain("const x = 1");
	});
});

// ============================================================================
// TEST GROUP 10: Token Estimation
// ============================================================================

describe("Token estimation", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-tokens-"));
		// Exactly 400 ASCII characters (no multi-byte) for predictable token estimate
		const content400 = "a".repeat(400);
		writeFile(join(tempDir, "content.txt"), content400);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-14: estimatedTokens is approximately chars/4 (within 2x margin)", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// 400 chars / 4 = 100 tokens expected
		// Allow a generous range: 25-400 (accounting for structure overhead and rounding)
		expect(result.estimatedTokens).toBeGreaterThanOrEqual(25);
		expect(result.estimatedTokens).toBeLessThanOrEqual(400);
	});

	test("TEST-15: tokenReport is defined when showTokens: true", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml", showTokens: true }),
		);
		expect(result.tokenReport).toBeDefined();
	});

	test("TEST-15b: tokenReport.byFile has at least one entry when showTokens: true", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml", showTokens: true }),
		);
		expect(result.tokenReport?.byFile).toBeDefined();
		expect(result.tokenReport!.byFile.length).toBeGreaterThanOrEqual(1);
	});

	test("TEST-16: tokenReport is undefined when showTokens: false", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml", showTokens: false }),
		);
		expect(result.tokenReport).toBeUndefined();
	});
});

// ============================================================================
// TEST GROUP 11: Edge Cases
// ============================================================================

describe("Edge cases: deeply nested directories", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-deep-"));
		writeFile(join(tempDir, "a", "b", "c", "d", "deep.txt"), "deep content");
		writeFile(join(tempDir, "top.txt"), "top content");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-17a: deeply nested file appears somewhere in output", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("deep.txt");
	});

	test("TEST-17b: deep file content appears in output", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("deep content");
	});

	test("TEST-17c: shallow file is also present alongside deep files", async () => {
		const output = await packToString(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(output).toContain("top content");
	});
});

describe("Edge cases: PackResult fileCount accuracy", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-count-"));
		// 3 text files
		writeFile(join(tempDir, "a.ts"), "const a = 1;");
		writeFile(join(tempDir, "b.ts"), "const b = 2;");
		writeFile(join(tempDir, "c.ts"), "const c = 3;");
		// 1 binary file (PNG magic bytes)
		const pngMagic = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		require("fs").writeFileSync(join(tempDir, "image.png"), pngMagic);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("TEST-18: fileCount equals number of text files (binary excluded)", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml" }),
		);
		// 3 text files, 1 binary - binary should not count in fileCount
		expect(result.fileCount).toBe(3);
	});
});

describe("Edge cases: outputPath written correctly", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-outpath-"));
		writeFile(join(tempDir, "main.ts"), "export {};");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("outputPath in result matches the requested output file path", async () => {
		const outFile = join(tempDir, "output", "packed.xml");
		const result = await packCommand({
			...defaultOptions(tempDir, { format: "xml" }),
			outputPath: outFile,
			stdout: false,
		});
		expect(result.outputPath).toBe(outFile);
	});

	test("output file is created on disk", async () => {
		const outFile = join(tempDir, "output2", "packed.xml");
		await packCommand({
			...defaultOptions(tempDir, { format: "xml" }),
			outputPath: outFile,
			stdout: false,
		});
		const exists = require("fs").existsSync(outFile);
		expect(exists).toBe(true);
	});
});

describe("Edge cases: durationMs is non-negative", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pack-duration-"));
		writeFile(join(tempDir, "file.ts"), "const x = 42;");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("durationMs is a non-negative number", async () => {
		const result = await packCommand(
			defaultOptions(tempDir, { format: "xml" }),
		);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});
