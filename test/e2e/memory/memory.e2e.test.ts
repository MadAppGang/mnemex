import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TestWorkspace } from "../../helpers/test-workspace.js";
import { MemoryStore } from "../../../src/memory/store.js";

describe("MemoryStore E2E", () => {
	let ws: TestWorkspace;
	let store: MemoryStore;

	beforeEach(() => {
		ws = TestWorkspace.create("memory");
		store = ws.createMemoryStore();
	});

	afterEach(() => ws?.cleanup());

	// FR-3.1: Write creates file + index
	test("write: creates memory file and index entry", () => {
		const memory = store.write(
			"auth-pattern",
			"# Auth Pattern\nUse JWT tokens.",
		);

		expect(memory.key).toBe("auth-pattern");
		expect(memory.content).toBe("# Auth Pattern\nUse JWT tokens.");
		expect(memory.createdAt).toBeTruthy();
		expect(memory.updatedAt).toBeTruthy();
	});

	// FR-3.2: Read returns exact content
	test("read: returns exact content for existing key", () => {
		store.write("test-key", "Hello World");

		const result = store.read("test-key");
		expect(result).not.toBeNull();
		expect(result!.content).toBe("Hello World");
		expect(result!.key).toBe("test-key");
	});

	// FR-3.2: Read returns null for missing
	test("read: returns null for missing key", () => {
		const result = store.read("nonexistent");
		expect(result).toBeNull();
	});

	// FR-3.3: List in descending updatedAt order
	test("list: returns memories sorted by updatedAt descending", async () => {
		store.write("first", "content 1");
		// Small delay to ensure different timestamps
		await new Promise((r) => setTimeout(r, 10));
		store.write("second", "content 2");
		await new Promise((r) => setTimeout(r, 10));
		store.write("third", "content 3");

		const list = store.list();
		expect(list.length).toBe(3);
		expect(list[0].key).toBe("third");
		expect(list[2].key).toBe("first");
	});

	// FR-3.4: Delete removes file and index
	test("delete: removes memory and returns true", () => {
		store.write("to-delete", "temporary");

		const deleted = store.delete("to-delete");
		expect(deleted).toBe(true);

		const result = store.read("to-delete");
		expect(result).toBeNull();

		const list = store.list();
		expect(list.find((m) => m.key === "to-delete")).toBeUndefined();
	});

	// FR-3.4: Delete returns false for missing
	test("delete: returns false for nonexistent key", () => {
		const deleted = store.delete("never-existed");
		expect(deleted).toBe(false);
	});

	// FR-3.5: Key validation
	test("key validation: rejects empty key", () => {
		expect(() => store.write("", "content")).toThrow();
	});

	test("key validation: rejects key with special chars", () => {
		expect(() => store.write("hello/world", "content")).toThrow();
		expect(() => store.write("hello world", "content")).toThrow();
		expect(() => store.write("hello.world", "content")).toThrow();
	});

	test("key validation: accepts alphanumeric with hyphens and underscores", () => {
		const memory = store.write("my-key_123", "content");
		expect(memory.key).toBe("my-key_123");
	});

	test("key validation: rejects key over 128 chars", () => {
		const longKey = "a".repeat(129);
		expect(() => store.write(longKey, "content")).toThrow();
	});

	// FR-3.6: createdAt preserved on update
	test("update: preserves createdAt, updates updatedAt", async () => {
		const original = store.write("evolving", "version 1");
		const originalCreatedAt = original.createdAt;

		await new Promise((r) => setTimeout(r, 10));

		const updated = store.write("evolving", "version 2");

		expect(updated.createdAt).toBe(originalCreatedAt);
		expect(updated.updatedAt).not.toBe(original.updatedAt);

		const read = store.read("evolving");
		expect(read!.content).toBe("version 2");
	});

	// FR-3.7: Persistence across instances
	test("persistence: new MemoryStore reads previous writes", () => {
		store.write("persistent-key", "persistent value");

		// Create a new MemoryStore pointing at the same indexDir
		const store2 = new MemoryStore(ws.indexDir);
		const result = store2.read("persistent-key");

		expect(result).not.toBeNull();
		expect(result!.content).toBe("persistent value");
	});
});
