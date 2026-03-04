/**
 * Memory Store
 *
 * CRUD operations for project memories stored as markdown files
 * in .claudemem/memories/. Maintains a memories.json index for fast listing.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
	renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface Memory {
	key: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}

interface MemoryIndex {
	memories: Record<string, { createdAt: string; updatedAt: string }>;
}

/** Max key length */
const MAX_KEY_LENGTH = 128;

/** Key validation regex: alphanumeric, hyphens, underscores */
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export class MemoryStore {
	private memoriesDir: string;
	private indexPath: string;

	constructor(indexDir: string) {
		this.memoriesDir = join(indexDir, "memories");
		this.indexPath = join(this.memoriesDir, "memories.json");
		this.ensureDir();
	}

	/**
	 * Write or update a memory.
	 */
	write(key: string, content: string): Memory {
		this.validateKey(key);

		const index = this.loadIndex();
		const now = new Date().toISOString();
		const existing = index.memories[key];

		const memory: Memory = {
			key,
			content,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		// Write memory file atomically
		const filePath = this.memoryPath(key);
		atomicWriteFile(filePath, content);

		// Update index atomically
		index.memories[key] = {
			createdAt: memory.createdAt,
			updatedAt: memory.updatedAt,
		};
		this.saveIndex(index);

		return memory;
	}

	/**
	 * Read a memory by key.
	 */
	read(key: string): Memory | null {
		this.validateKey(key);

		const index = this.loadIndex();
		const meta = index.memories[key];
		if (!meta) return null;

		const filePath = this.memoryPath(key);
		if (!existsSync(filePath)) {
			// Index is stale — clean up
			delete index.memories[key];
			this.saveIndex(index);
			return null;
		}

		const content = readFileSync(filePath, "utf-8");
		return {
			key,
			content,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
		};
	}

	/**
	 * List all memories (metadata only, no content).
	 */
	list(): Array<{ key: string; createdAt: string; updatedAt: string }> {
		const index = this.loadIndex();
		return Object.entries(index.memories)
			.map(([key, meta]) => ({
				key,
				createdAt: meta.createdAt,
				updatedAt: meta.updatedAt,
			}))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * Delete a memory by key.
	 */
	delete(key: string): boolean {
		this.validateKey(key);

		const index = this.loadIndex();
		if (!index.memories[key]) return false;

		const filePath = this.memoryPath(key);
		try {
			unlinkSync(filePath);
		} catch {
			// File already gone
		}

		delete index.memories[key];
		this.saveIndex(index);
		return true;
	}

	private validateKey(key: string): void {
		if (!key || key.length > MAX_KEY_LENGTH) {
			throw new Error(
				`Memory key must be 1-${MAX_KEY_LENGTH} characters, got ${key.length}`,
			);
		}
		if (!KEY_PATTERN.test(key)) {
			throw new Error(
				`Memory key must contain only alphanumeric characters, hyphens, and underscores`,
			);
		}
	}

	private memoryPath(key: string): string {
		return join(this.memoriesDir, `${key}.md`);
	}

	private loadIndex(): MemoryIndex {
		if (!existsSync(this.indexPath)) {
			return { memories: {} };
		}
		try {
			return JSON.parse(readFileSync(this.indexPath, "utf-8"));
		} catch {
			return { memories: {} };
		}
	}

	private saveIndex(index: MemoryIndex): void {
		atomicWriteFile(this.indexPath, JSON.stringify(index, null, 2));
	}

	private ensureDir(): void {
		if (!existsSync(this.memoriesDir)) {
			mkdirSync(this.memoriesDir, { recursive: true });
		}
	}
}

/**
 * Write a file atomically: write to temp, then rename.
 */
function atomicWriteFile(filePath: string, content: string): void {
	const tmpPath = filePath + `.tmp-${randomBytes(6).toString("hex")}`;
	writeFileSync(tmpPath, content, "utf-8");
	renameSync(tmpPath, filePath);
}
