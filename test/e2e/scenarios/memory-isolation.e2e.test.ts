// test/e2e/scenarios/memory-isolation.e2e.test.ts
//
// FR-4.3: Two independent workspaces have isolated memories.
// Verifies that MemoryStore instances backed by different .claudemem
// directories do not share data.

import { describe, test, expect, afterEach } from "bun:test";
import { TestWorkspace } from "../../helpers/test-workspace.js";
import { MemoryStore } from "../../../src/memory/store.js";

describe("Memory Isolation Scenarios (FR-4.3)", () => {
  let ws1: TestWorkspace;
  let ws2: TestWorkspace;

  afterEach(() => {
    ws1?.cleanup();
    ws2?.cleanup();
  });

  test("separate workspaces have independent memory stores", () => {
    ws1 = TestWorkspace.create("scenario-memory-ws1");
    ws2 = TestWorkspace.create("scenario-memory-ws2");

    const store1 = ws1.createMemoryStore();
    const store2 = ws2.createMemoryStore();

    // Write different patterns to each workspace's store
    store1.write("pattern-a", "# Pattern A\nThis belongs to workspace 1.");
    store2.write("pattern-b", "# Pattern B\nThis belongs to workspace 2.");

    // ws1's store must NOT see ws2's key
    const ws1ReadPatternB = store1.read("pattern-b");
    expect(ws1ReadPatternB).toBeNull();

    // ws2's store must NOT see ws1's key
    const ws2ReadPatternA = store2.read("pattern-a");
    expect(ws2ReadPatternA).toBeNull();

    // Each store can read its own key correctly
    const ws1ReadPatternA = store1.read("pattern-a");
    expect(ws1ReadPatternA).not.toBeNull();
    expect(ws1ReadPatternA!.key).toBe("pattern-a");
    expect(ws1ReadPatternA!.content).toContain("workspace 1");

    const ws2ReadPatternB = store2.read("pattern-b");
    expect(ws2ReadPatternB).not.toBeNull();
    expect(ws2ReadPatternB!.key).toBe("pattern-b");
    expect(ws2ReadPatternB!.content).toContain("workspace 2");

    // Each store's list contains only its own entries
    const list1 = store1.list();
    expect(list1.length).toBe(1);
    expect(list1[0].key).toBe("pattern-a");

    const list2 = store2.list();
    expect(list2.length).toBe(1);
    expect(list2[0].key).toBe("pattern-b");

    // The index directories must be distinct
    expect(ws1.indexDir).not.toBe(ws2.indexDir);
  });
});
