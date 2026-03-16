/**
 * Location Backend
 *
 * Glob-matches indexed files to find results by path pattern.
 * Activated for: location
 */

import type { IFileTracker } from "../../core/tracker.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";

export class LocationBackend implements ISearchBackend {
	readonly name = "location" as const;

	constructor(private tracker: IFileTracker) {}

	async search(
		query: string,
		intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		const limit = options.limit ?? 10;

		// Build pattern from: options.filePattern, extracted entities, or the query itself
		const pattern = buildPattern(
			options.filePattern,
			intent.extractedEntities,
			query,
		);
		if (!pattern) return [];

		// Get all indexed files
		const allFiles = this.tracker.getAllFiles();
		if (signal.aborted) return [];

		// Filter by pattern
		const regexPat = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars (except * and ?)
			.replace(/\\\*/g, "*") // Un-escape * for further processing
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, ".");

		let regex: RegExp;
		try {
			regex = new RegExp(regexPat, "i");
		} catch {
			return [];
		}

		const matched = allFiles.filter((f) => regex.test(f.path));

		// Sort by path length (shorter = more specific match)
		matched.sort((a, b) => a.path.length - b.path.length);

		const backendName = this.name;
		return matched.slice(0, limit).map((f, idx) => ({
			file: f.path,
			startLine: 1,
			snippet: f.path,
			// Score based on position in sorted list
			score: 1 - idx / Math.max(matched.length, 1),
			backend: backendName,
		}));
	}
}

/**
 * Build a glob pattern from available sources.
 */
function buildPattern(
	filePattern: string | undefined,
	extractedEntities: string[],
	query: string,
): string | null {
	if (filePattern) return filePattern;

	// Look for path-like entities
	for (const entity of extractedEntities) {
		if (entity.includes("/") || entity.includes(".")) {
			return `*${entity}*`;
		}
	}

	// Try to extract path fragment from query
	const pathMatch = query.match(/[\w\/.-]+\.(ts|js|py|go|rs|java|cpp|c|h)\b/);
	if (pathMatch) return `*${pathMatch[0]}*`;

	// Use the query as a folder/name fragment
	const words = query
		.split(/\s+/)
		.filter(
			(w) => w.length > 2 && !/^(in|the|for|of|at|under|inside)$/i.test(w),
		);
	if (words.length > 0) {
		return `*${words[0]}*`;
	}

	return null;
}
