/**
 * Cloud configuration helpers
 *
 * Provides convenience functions for reading cloud/team settings from
 * the project configuration, following the same patterns as src/config.ts.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadProjectConfig } from "../config.js";
import type { ICloudIndexClient, TeamConfig } from "./types.js";
import { createThinCloudClient } from "./thin-client.js";
import { createSmartCloudClient } from "./smart-client.js";

const execAsync = promisify(exec);

/** Default cloud API endpoint */
export const DEFAULT_CLOUD_ENDPOINT = "https://api.mnemex.dev";

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Check whether cloud mode is enabled for the given project.
 * Cloud is enabled when the project config has a `team` block with an `orgSlug`.
 */
export function isCloudEnabled(projectPath: string): boolean {
	const config = loadProjectConfig(projectPath);
	return !!config?.team?.orgSlug;
}

/**
 * Get the cloud upload mode for the project.
 * Returns "thin" if not explicitly configured.
 */
export function getCloudMode(projectPath: string): "thin" | "smart" {
	const config = loadProjectConfig(projectPath);
	return config?.team?.cloudMode ?? "thin";
}

/**
 * Get the TeamConfig block from the project configuration.
 * Returns undefined if no team block exists.
 */
export function getTeamConfig(projectPath: string): TeamConfig | undefined {
	const config = loadProjectConfig(projectPath);
	return config?.team;
}

/**
 * Get the cloud API endpoint for the project.
 * Returns the default endpoint if not configured.
 */
export function getCloudEndpoint(projectPath: string): string {
	const config = loadProjectConfig(projectPath);
	return config?.team?.cloudEndpoint ?? DEFAULT_CLOUD_ENDPOINT;
}

/**
 * Create the appropriate ICloudIndexClient for the project based on the
 * configured cloud mode (thin vs smart).
 *
 * @param projectPath - absolute path to the project root
 * @param token       - Bearer authentication token
 */
export function createCloudClientFromConfig(
	projectPath: string,
	token: string,
): ICloudIndexClient {
	const mode = getCloudMode(projectPath);
	const endpoint = getCloudEndpoint(projectPath);
	if (mode === "smart") {
		return createSmartCloudClient({ endpoint, token });
	}
	return createThinCloudClient({ endpoint, token });
}

/**
 * Derive the repository slug for the cloud API.
 *
 * Resolution order:
 * 1. team.repoSlug from project config (explicit, wins)
 * 2. Derived from `git remote get-url origin` + team.orgSlug:
 *    "https://github.com/acme/my-repo.git" → "acme-corp/my-repo"
 *    where "acme-corp" comes from TeamConfig.orgSlug.
 *
 * @throws Error if no team config exists or the slug cannot be derived
 */
export async function getRepoSlug(projectPath: string): Promise<string> {
	const config = loadProjectConfig(projectPath);
	const team = config?.team;

	if (!team) {
		throw new Error(
			`No team configuration found for project at ${projectPath}. ` +
				"Add a 'team' block with 'orgSlug' to your mnemex.json.",
		);
	}

	// Explicit slug wins
	if (team.repoSlug) {
		return team.repoSlug;
	}

	// Derive from git remote
	const repoName = await deriveRepoNameFromRemote(projectPath);
	return `${team.orgSlug}/${repoName}`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extract the repository name from the git remote URL.
 *
 * Examples:
 *   https://github.com/acme/my-repo.git  → "my-repo"
 *   git@github.com:acme/my-repo.git      → "my-repo"
 *   https://github.com/acme/my-repo      → "my-repo"
 */
async function deriveRepoNameFromRemote(projectPath: string): Promise<string> {
	try {
		const { stdout } = await execAsync("git remote get-url origin", {
			cwd: projectPath,
		});
		const remoteUrl = stdout.trim();
		return parseRepoNameFromUrl(remoteUrl);
	} catch {
		throw new Error(
			"Could not determine repository slug: failed to run " +
				"'git remote get-url origin'. Set team.repoSlug explicitly in " +
				"your mnemex.json.",
		);
	}
}

/**
 * Parse the bare repository name (without .git suffix) from a remote URL.
 * Supports HTTPS, SSH, and SCP-style git remote URLs.
 */
export function parseRepoNameFromUrl(remoteUrl: string): string {
	// Strip trailing .git suffix and trailing slashes
	let url = remoteUrl
		.trim()
		.replace(/\.git$/, "")
		.replace(/\/$/, "");

	// Extract the last path segment
	// Works for both HTTPS (https://github.com/owner/repo) and
	// SSH/SCP (git@github.com:owner/repo) formats
	const lastSlash = url.lastIndexOf("/");
	const lastColon = url.lastIndexOf(":");

	const separatorIdx = Math.max(lastSlash, lastColon);
	if (separatorIdx !== -1) {
		url = url.slice(separatorIdx + 1);
	}

	if (!url) {
		throw new Error(
			`Cannot parse repository name from remote URL: ${remoteUrl}`,
		);
	}

	return url;
}
