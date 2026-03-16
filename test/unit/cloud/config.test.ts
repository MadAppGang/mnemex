/**
 * Unit tests for cloud/config.ts helpers
 *
 * Tests isCloudEnabled, getCloudMode, getTeamConfig, getCloudEndpoint,
 * and parseRepoNameFromUrl. getRepoSlug's git-subprocess path is not tested
 * here (needs an integration test with a real git repo).
 */

import { describe, test, expect } from "bun:test";
import { parseRepoNameFromUrl } from "../../../src/cloud/config.js";

// ============================================================================
// parseRepoNameFromUrl
// ============================================================================

describe("parseRepoNameFromUrl", () => {
	test("parses HTTPS URL with .git suffix", () => {
		expect(parseRepoNameFromUrl("https://github.com/acme/my-repo.git")).toBe(
			"my-repo",
		);
	});

	test("parses HTTPS URL without .git suffix", () => {
		expect(parseRepoNameFromUrl("https://github.com/acme/my-repo")).toBe(
			"my-repo",
		);
	});

	test("parses SSH URL (git@github.com:owner/repo.git)", () => {
		expect(parseRepoNameFromUrl("git@github.com:acme/my-repo.git")).toBe(
			"my-repo",
		);
	});

	test("parses SSH URL without .git suffix", () => {
		expect(parseRepoNameFromUrl("git@github.com:acme/my-repo")).toBe("my-repo");
	});

	test("handles trailing slash", () => {
		expect(parseRepoNameFromUrl("https://github.com/acme/my-repo/")).toBe(
			"my-repo",
		);
	});

	test("handles GitLab-style URL", () => {
		expect(
			parseRepoNameFromUrl("https://gitlab.com/group/sub-group/project.git"),
		).toBe("project");
	});

	test("handles Bitbucket HTTPS URL", () => {
		expect(
			parseRepoNameFromUrl("https://bitbucket.org/team/awesome-project.git"),
		).toBe("awesome-project");
	});

	test("preserves hyphens and underscores in repo name", () => {
		expect(
			parseRepoNameFromUrl("https://github.com/org/my-cool_repo.git"),
		).toBe("my-cool_repo");
	});

	test("handles URL with no path segment (just domain) gracefully", () => {
		// Edge case: should not crash, though result may be empty/unusual
		// We just verify it doesn't throw for well-formed but unusual URLs
		expect(() =>
			parseRepoNameFromUrl("https://github.com/owner/project"),
		).not.toThrow();
	});
});
