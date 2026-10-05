/**
 * The human (non-`--agent`) half of the overlay contract (step 3, R3.9):
 * one "Including N uncommitted file(s)" line, an `[uncommitted]` marker on
 * each overlay row, and overlay ids kept out of the feedback hint.
 *
 * A child's stdout is a pipe, which turns agent mode on by itself, so human
 * output cannot be reached through the built binary in a test. These are the
 * helpers `handleSearch` renders it with.
 */

import { describe, expect, test } from "bun:test";
import {
	feedbackResultIds,
	overlayHumanNotice,
	searchResultLocation,
} from "../../../src/cli.js";
import { stubOverlayReport } from "../../helpers/overlay-report-stub.js";

describe("overlayHumanNotice", () => {
	test("on with served files: one line naming the count and the marker", () => {
		expect(
			overlayHumanNotice(
				stubOverlayReport({ state: "on", reason: "dirty", files: 1 }),
			),
		).toBe(
			"Including 1 uncommitted file (not yet indexed; marked [uncommitted]).",
		);
		expect(
			overlayHumanNotice(
				stubOverlayReport({ state: "on", reason: "dirty", files: 3 }),
			),
		).toBe(
			"Including 3 uncommitted files (not yet indexed; marked [uncommitted]).",
		);
	});

	test("nothing to say: off, on with nothing served, or no git repository", () => {
		expect(
			overlayHumanNotice(stubOverlayReport({ state: "off", reason: "flag" })),
		).toBeNull();
		expect(
			overlayHumanNotice(
				stubOverlayReport({ state: "on", reason: "index-current" }),
			),
		).toBeNull();
		expect(
			overlayHumanNotice(
				stubOverlayReport({ state: "skipped", reason: "no-git" }),
			),
		).toBeNull();
	});

	test("on, but files failed or pending: says the coverage is incomplete (review 2, MEDIUM 7)", () => {
		const allFailed = overlayHumanNotice(
			stubOverlayReport({
				state: "on",
				reason: "dirty",
				files: 0,
				filesFailed: 1,
				gaps: ["file-failed-embed"],
				gapDetails: [
					{
						token: "file-failed-embed",
						path: "src/b.ts",
						message: "a vector of width 0 for an 8-wide index",
					},
				],
			}),
		);
		expect(allFailed).toBe(
			"Uncommitted changes in 1 file are not included in these results (1 failed: embed); their indexed versions are shown.",
		);
		const mixed = overlayHumanNotice(
			stubOverlayReport({
				state: "on",
				reason: "dirty",
				files: 2,
				filesFailed: 1,
				filesPending: 2,
				gaps: ["file-failed-too-large", "embed-deadline"],
				gapDetails: [
					{
						token: "file-failed-too-large",
						path: "src/c.ts",
						message: "900000 bytes > 524288",
					},
					{
						token: "embed-deadline",
						message: "rebuild budget 8000 ms reached, the rest is pending",
					},
				],
			}),
		);
		expect(mixed).toBe(
			"Including 2 uncommitted files (not yet indexed; marked [uncommitted]). " +
				"Uncommitted changes in 3 more files are not included (1 failed: too-large, 2 pending: embed-deadline); their indexed versions are shown.",
		);
		const unclassified = overlayHumanNotice(
			stubOverlayReport({
				state: "on",
				reason: "index-current",
				filesUnclassified: 4,
			}),
		);
		expect(unclassified).toBe(
			"At least 4 recently indexed files were not checked against disk in this search; results for them may be stale.",
		);
	});

	test("skipped says so, and why (R3.11)", () => {
		expect(
			overlayHumanNotice(
				stubOverlayReport({ state: "skipped", reason: "embed-failed" }),
			),
		).toBe(
			"Uncommitted changes are not included in these results (overlay skipped: embed-failed).",
		);
	});
});

describe("the [uncommitted] marker and the feedback hint", () => {
	const chunk = (id: string) => ({
		id,
		filePath: `/w/src/${id}.ts`,
		startLine: 3,
		endLine: 9,
	});

	test("the location carries the marker only when given", () => {
		expect(searchResultLocation(chunk("a"), "[uncommitted]")).toBe(
			" /w/src/a.ts:3-9 [uncommitted]",
		);
		expect(searchResultLocation(chunk("a"))).toBe(" /w/src/a.ts:3-9");
	});

	test("feedback ids are index rows only; cloud values are index-like here", () => {
		const ids = feedbackResultIds([
			{ chunk: chunk("dirty1"), source: "dirty" },
			{ chunk: chunk("index1") },
			{ chunk: chunk("cloud1"), source: "cloud" },
		] as never);
		expect(ids).toEqual(["index1", "cloud1"]);
	});
});
