import { describe, test, expect } from "bun:test";
import { LspManager } from "../../../src/lsp/manager.js";

describe("LspManager E2E", () => {
	test("disabled: getClient returns null when LSP is disabled", async () => {
		const manager = new LspManager({
			enabled: false,
			timeoutMs: 10000,
			maxServers: 2,
			disabledLanguages: [],
			workspaceRoot: "/tmp/test",
			commandOverrides: {},
		});

		const client = await manager.getClient("typescript");
		expect(client).toBeNull();
	});

	test("unknown language: getClient returns null", async () => {
		const manager = new LspManager({
			enabled: true,
			timeoutMs: 10000,
			maxServers: 2,
			disabledLanguages: [],
			workspaceRoot: "/tmp/test",
			commandOverrides: {},
		});

		const client = await manager.getClient("brainfuck");
		expect(client).toBeNull();
	});

	test("disabled language: getClient returns null", async () => {
		const manager = new LspManager({
			enabled: true,
			timeoutMs: 10000,
			maxServers: 2,
			disabledLanguages: ["typescript"],
			workspaceRoot: "/tmp/test",
			commandOverrides: {},
		});

		const client = await manager.getClient("typescript");
		expect(client).toBeNull();
	});

	test("detectLanguageId: maps extensions correctly", () => {
		const manager = new LspManager({
			enabled: true,
			timeoutMs: 10000,
			maxServers: 2,
			disabledLanguages: [],
			workspaceRoot: "/tmp/test",
			commandOverrides: {},
		});

		expect(manager.detectLanguageId("file.ts")).toBe("typescript");
		expect(manager.detectLanguageId("file.tsx")).toBe("typescriptreact");
		expect(manager.detectLanguageId("file.py")).toBe("python");
		expect(manager.detectLanguageId("file.go")).toBe("go");
		expect(manager.detectLanguageId("file.rs")).toBe("rust");
		expect(manager.detectLanguageId("file.unknown")).toBeNull();
	});

	test("shutdown: completes even with no clients", async () => {
		const manager = new LspManager({
			enabled: false,
			timeoutMs: 10000,
			maxServers: 2,
			disabledLanguages: [],
			workspaceRoot: "/tmp/test",
			commandOverrides: {},
		});

		// Should not throw
		await manager.shutdown();
	});
});
