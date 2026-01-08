/**
 * Auto-update manager for claudemem CLI
 *
 * Features:
 * - Check npm registry for latest version
 * - Cache version checks (24h TTL)
 * - Perform self-update via npm/bun
 * - Handle offline/network failures gracefully
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCache, isCacheValid, readCache, writeCache } from "./cache.js";
import { fetchLatestVersion } from "./registry.js";
import { isNewerVersion } from "./version.js";

export interface UpdateCheckResult {
	currentVersion: string;
	latestVersion: string;
	isUpdateAvailable: boolean;
	publishedAt?: string;
}

export interface UpdateOptions {
	/** Auto-approve update (skip prompt) */
	autoApprove?: boolean;

	/** Verbose output */
	verbose?: boolean;
}

export interface UpdateResult {
	success: boolean;
	newVersion?: string;
	error?: string;
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class UpdateManager {
	constructor(private packageName = "claude-codemem") {}

	/**
	 * Get current installed version from package.json
	 */
	getCurrentVersion(): string {
		try {
			const __dirname = dirname(fileURLToPath(import.meta.url));
			const pkgPath = join(__dirname, "../../package.json");
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			return pkg.version || "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/**
	 * Get cached version info (if valid)
	 */
	getCachedVersionInfo(): UpdateCheckResult | null {
		const cache = readCache();
		if (!cache) return null;

		if (!isCacheValid(cache, CACHE_MAX_AGE_MS)) return null;

		const current = this.getCurrentVersion();
		return {
			currentVersion: current,
			latestVersion: cache.latestVersion,
			isUpdateAvailable: isNewerVersion(current, cache.latestVersion),
			publishedAt: cache.publishedAt,
		};
	}

	/**
	 * Check for available updates (uses cache if fresh)
	 */
	async checkForUpdate(): Promise<UpdateCheckResult> {
		const current = this.getCurrentVersion();

		// Try cache first
		const cached = this.getCachedVersionInfo();
		if (cached) return cached;

		// Fetch from registry
		try {
			const info = await fetchLatestVersion(this.packageName);

			// Update cache
			writeCache({
				latestVersion: info.version,
				checkedAt: Date.now(),
				publishedAt: info.publishedAt,
			});

			return {
				currentVersion: current,
				latestVersion: info.version,
				isUpdateAvailable: isNewerVersion(current, info.version),
				publishedAt: info.publishedAt,
			};
		} catch (error) {
			// If fetch fails, return current version (no update available)
			return {
				currentVersion: current,
				latestVersion: current,
				isUpdateAvailable: false,
			};
		}
	}

	/**
	 * Perform self-update using package manager
	 */
	async performUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
		const check = await this.checkForUpdate();

		if (!check.isUpdateAvailable) {
			return { success: false, error: "Already on latest version" };
		}

		// Detect runtime (Bun vs Node)
		const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
		const packageManager = isBun ? "bun" : "npm";
		const args = ["install", "-g", `${this.packageName}@latest`];

		if (options.verbose) {
			console.log(`Running: ${packageManager} ${args.join(" ")}`);
		}

		return new Promise((resolve) => {
			const proc = spawn(packageManager, args, {
				stdio: options.verbose ? "inherit" : "pipe",
			});

			proc.on("error", (error) => {
				resolve({
					success: false,
					error: `Failed to spawn ${packageManager}: ${error.message}`,
				});
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					resolve({
						success: false,
						error: `${packageManager} exited with code ${code}`,
					});
					return;
				}

				// Verify update
				clearCache(); // Clear cache so next check is fresh
				const newVersion = this.getCurrentVersion();

				if (newVersion === check.currentVersion) {
					resolve({
						success: false,
						error: "Update completed but version unchanged",
					});
					return;
				}

				resolve({ success: true, newVersion });
			});
		});
	}

	/**
	 * Clear update cache (for testing)
	 */
	clearCache(): void {
		clearCache();
	}
}
