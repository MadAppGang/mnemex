/**
 * Auto-update manager for mnemex CLI
 *
 * Features:
 * - Check npm registry for latest version
 * - Cache version checks (24h TTL)
 * - Perform self-update via npm/bun
 * - Handle offline/network failures gracefully
 */

import { spawn } from "node:child_process";
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
	private currentVersion: string;

	constructor(
		currentVersion: string,
		private packageName = "mnemex",
	) {
		this.currentVersion = currentVersion;
	}

	/**
	 * Get current installed version
	 */
	getCurrentVersion(): string {
		return this.currentVersion;
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
	 * Detect how the package was installed (brew, bun, or npm)
	 */
	private detectPackageManager(): "brew" | "bun" | "npm" {
		const scriptPath = process.argv[1] || "";

		// Priority 1: Homebrew
		if (
			scriptPath.includes("/opt/homebrew/") ||
			scriptPath.includes("/usr/local/Cellar/")
		) {
			return "brew";
		}

		// Priority 2: Bun
		if (scriptPath.includes("/.bun/") || scriptPath.includes("/bun/")) {
			return "bun";
		}

		// Check Bun runtime as fallback
		const isBunRuntime =
			typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
		const isBunExec = process.execPath.toLowerCase().includes("bun");
		if (isBunRuntime || isBunExec) {
			return "bun";
		}

		return "npm";
	}

	async performUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
		const check = await this.checkForUpdate();

		if (!check.isUpdateAvailable) {
			return { success: false, error: "Already on latest version" };
		}

		// Detect package manager based on installation method
		const packageManager = this.detectPackageManager();
		let args: string[];
		if (packageManager === "brew") {
			args = ["upgrade", "mnemex"];
		} else {
			const subcommand = packageManager === "bun" ? "add" : "install";
			args = [subcommand, "-g", `${this.packageName}@latest`];
		}

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

				// Trust the package manager exit code (like claudish does).
				// We can't verify the new version in-process because
				// this.currentVersion is frozen at process start.
				clearCache();
				resolve({ success: true, newVersion: check.latestVersion });
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
