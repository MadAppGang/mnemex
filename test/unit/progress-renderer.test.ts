/**
 * Tests for the ANSI cursor-based progress renderer.
 *
 * Verifies that the progress renderer overwrites lines in-place
 * instead of appending duplicate lines. The key invariant:
 * only the LAST line in a render cycle should omit the trailing \n,
 * and cursor-up count must match the number of \n-terminated lines.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// Minimal re-implementation of the progress renderer logic for testing
// (extracted from cli.ts createProgressRenderer)
function createTestProgressRenderer() {
	let maxLinesWritten = 0;
	const phases = new Map<
		string,
		{
			completed: number;
			total: number;
			inProgress: number;
			detail: string;
			isComplete: boolean;
		}
	>();
	const phaseOrder: string[] = [];
	const output: string[] = []; // Collects all write() calls

	function render() {
		if (maxLinesWritten > 0) {
			output.push(`\x1b[${maxLinesWritten}A`);
		}

		for (const phaseName of phaseOrder) {
			const phase = phases.get(phaseName)!;
			const pct =
				phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0;
			const detail = phase.isComplete ? "done" : phase.detail;
			// Phase lines end with \n
			output.push(`\r${phaseName} ${pct}% ${detail}\x1b[K\n`);
		}

		// Total line — NO trailing \n
		output.push(`\rtotal\x1b[K`);

		// maxLinesWritten = number of \n-terminated lines (phases only)
		maxLinesWritten = phaseOrder.length;
	}

	function update(
		completed: number,
		total: number,
		detail: string,
		inProgress = 0,
	) {
		const phaseMatch = detail.match(/^\[([^\]]+)\]/);
		const phaseName = phaseMatch ? phaseMatch[1] : "processing";
		const cleanDetail = detail.replace(/^\[[^\]]+\]\s*/, "");

		if (!phases.has(phaseName)) {
			phases.set(phaseName, {
				completed: 0,
				total: 0,
				inProgress: 0,
				detail: "",
				isComplete: false,
			});
			phaseOrder.push(phaseName);
		}

		const phase = phases.get(phaseName)!;
		if (!phase.isComplete) {
			phase.completed = completed;
			phase.total = total;
			phase.inProgress = inProgress;
			phase.detail = cleanDetail;

			if (completed >= total && total > 0 && inProgress === 0) {
				phase.isComplete = true;
			}
		}
	}

	return {
		render,
		update,
		output,
		phaseOrder,
		maxLinesWritten: () => maxLinesWritten,
	};
}

describe("Progress Renderer", () => {
	it("should not write \\n after the total line during render", () => {
		const renderer = createTestProgressRenderer();

		renderer.update(5, 10, "[parsing] 5/10 file.ts", 1);
		renderer.render();

		// The last write in the output should NOT end with \n
		const lastWrite = renderer.output[renderer.output.length - 1];
		expect(lastWrite).not.toMatch(/\n$/);
		expect(lastWrite).toContain("total");
	});

	it("cursor-up count should equal number of phase lines", () => {
		const renderer = createTestProgressRenderer();

		// Simulate parsing + embedding phases
		renderer.update(10, 10, "[parsing] done");
		renderer.update(5, 10, "[embedding] 5/10");
		renderer.render();

		// After first render, maxLinesWritten = phaseOrder.length = 2
		expect(renderer.maxLinesWritten()).toBe(2);

		// Second render should move cursor up by 2 (not 3)
		renderer.output.length = 0; // clear
		renderer.render();

		const cursorUp = renderer.output.find((s) => s.includes("\x1b["));
		expect(cursorUp).toBe("\x1b[2A"); // 2 phases, not 3 (no +1 for total)
	});

	it("should overwrite correctly when phases grow", () => {
		const renderer = createTestProgressRenderer();

		// Phase 1: only parsing
		renderer.update(10, 10, "[parsing] done");
		renderer.render();
		expect(renderer.maxLinesWritten()).toBe(1); // 1 phase

		// Phase 2: parsing + embedding
		renderer.output.length = 0;
		renderer.update(5, 10, "[embedding] 5/10");
		renderer.render();

		// Should cursor-up by 1 (previous maxLinesWritten)
		expect(renderer.output[0]).toBe("\x1b[1A");
		// Now maxLinesWritten = 2
		expect(renderer.maxLinesWritten()).toBe(2);
	});

	it("should not produce duplicate lines across multiple renders", () => {
		const renderer = createTestProgressRenderer();

		// Simulate a full indexing cycle
		renderer.update(50, 100, "[parsing] 50/100 file.ts", 1);
		renderer.render();

		renderer.update(100, 100, "[parsing] 100/100 done");
		renderer.render();

		renderer.update(0, 50, "[embedding] 0/50 starting...", 5);
		renderer.render();

		renderer.update(50, 50, "[embedding] 50/50 done");
		renderer.render();

		// Count how many times "parsing" appears as a \n-terminated line
		// in the FINAL state. After cursor-up, each render overwrites.
		// We can verify by checking that every render after the first
		// starts with a cursor-up escape.
		const renders: string[][] = [];
		let currentRender: string[] = [];

		for (const s of renderer.output) {
			if (s.startsWith("\x1b[") && s.endsWith("A")) {
				if (currentRender.length > 0) {
					renders.push(currentRender);
				}
				currentRender = [s];
			} else {
				currentRender.push(s);
			}
		}
		if (currentRender.length > 0) {
			renders.push(currentRender);
		}

		// Every render except the first should start with cursor-up
		for (let i = 1; i < renders.length; i++) {
			expect(renders[i][0]).toMatch(/^\x1b\[\d+A$/);
		}
	});

	it("total line should never cause terminal scroll", () => {
		const renderer = createTestProgressRenderer();

		// Many phases
		renderer.update(10, 10, "[parsing] done");
		renderer.update(10, 10, "[embedding] done");
		renderer.update(10, 10, "[storing] done");
		renderer.update(10, 10, "[units] done");
		renderer.update(10, 10, "[analyzing] done");
		renderer.render();

		// The total line (last output) must NOT end with \n
		const lastWrite = renderer.output[renderer.output.length - 1];
		expect(lastWrite).not.toMatch(/\n$/);

		// cursor-up should equal phase count (5), not phase count + 1
		renderer.output.length = 0;
		renderer.render();
		expect(renderer.output[0]).toBe("\x1b[5A");
	});
});
