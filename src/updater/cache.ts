/**
 * Cache management for update checks
 * Cache location: ~/.claudemem/update-cache.json
 * TTL: 24 hours
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UpdateCacheEntry {
	latestVersion: string;
	checkedAt: number;
	publishedAt?: string;
}

const CACHE_DIR = join(homedir(), ".claudemem");
const CACHE_FILE = join(CACHE_DIR, "update-cache.json");

export function getCacheFilePath(): string {
	return CACHE_FILE;
}

export function readCache(): UpdateCacheEntry | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;

		const content = readFileSync(CACHE_FILE, "utf-8");
		const parsed = JSON.parse(content);

		// Validate structure
		if (!parsed.latestVersion || typeof parsed.checkedAt !== "number") {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

export function writeCache(entry: UpdateCacheEntry): void {
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}

		writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), "utf-8");
	} catch {
		// Silently ignore write errors
	}
}

export function isCacheValid(
	entry: UpdateCacheEntry,
	maxAgeMs: number,
): boolean {
	const age = Date.now() - entry.checkedAt;
	return age < maxAgeMs;
}

export function clearCache(): void {
	try {
		if (existsSync(CACHE_FILE)) {
			unlinkSync(CACHE_FILE);
		}
	} catch {
		// Silently ignore
	}
}
