/**
 * Pack Command Pipeline
 *
 * Orchestrates the pack operation:
 * 1. Load exclude patterns (config + gitignore)
 * 2. Walk files
 * 3. Read content
 * 4. Detect binary files
 * 5. Annotate token estimates
 * 6. Build directory tree
 * 7. Format output
 * 8. Write atomically (write .tmp, rename) or stdout
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getExcludePatterns } from "../config.js";
import { walkFiles } from "../shared/file-walker.js";
import {
	extensionToLanguage,
	isBinaryFile,
} from "../shared/binary-detector.js";
import { buildTree } from "./tree-builder.js";
import { annotateTokenEstimates, buildTokenReport } from "./token-counter.js";
import { formatXml } from "./formats/xml.js";
import { formatMarkdown } from "./formats/markdown.js";
import { formatPlain } from "./formats/plain.js";
import type { FileEntry, PackMeta, PackOptions, PackResult } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default maximum file size to include (1 MB) */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** claudemem version - read from package.json at call time */
let _version: string | undefined;

function getVersion(): string {
	if (_version) return _version;
	try {
		// Walk up from this file's location to find package.json
		// This file is at src/pack/index.ts → package.json is at ../../package.json
		const pkgPath = resolve(
			dirname(new URL(import.meta.url).pathname),
			"../../package.json",
		);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
			version: string;
		};
		_version = pkg.version;
	} catch {
		_version = "0.0.0";
	}
	return _version;
}

// ============================================================================
// Progress Callback
// ============================================================================

/** Progress callback type */
export type ProgressCallback = (
	phase: string,
	current: number,
	total: number,
) => void;

// ============================================================================
// Main Pipeline
// ============================================================================

/**
 * Run the pack command pipeline.
 *
 * @param options - Pack options
 * @param onProgress - Optional progress callback
 * @returns PackResult with statistics about the operation
 */
export async function packCommand(
	options: PackOptions,
	onProgress?: ProgressCallback,
): Promise<PackResult> {
	const startTime = Date.now();

	const projectPath = resolve(options.projectPath);
	const format = options.format ?? "xml";
	const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

	// ─── Phase 1: Load exclude patterns ─────────────────────────────────────
	onProgress?.("load-patterns", 0, 1);

	// Get default + config + gitignore patterns (honour --no-gitignore)
	const baseExcludePatterns = getExcludePatterns(
		projectPath,
		options.useGitignore,
	);

	// Merge with any extra patterns from options
	const allExcludePatterns = [
		...baseExcludePatterns,
		...options.excludePatterns,
	];

	onProgress?.("load-patterns", 1, 1);

	// ─── Phase 2: Walk files ─────────────────────────────────────────────────
	onProgress?.("walk-files", 0, 1);

	const walkEntries = walkFiles(projectPath, {
		excludePatterns: allExcludePatterns,
		includePatterns: options.includePatterns,
		// No onlyExtensions — pack includes all text files
	});

	onProgress?.("walk-files", walkEntries.length, walkEntries.length);

	// ─── Phase 3: Read content + detect binary + filter by size ─────────────
	const fileEntries: FileEntry[] = [];
	let binarySkipped = 0;
	let sizeSkipped = 0;

	const totalFiles = walkEntries.length;
	let processed = 0;

	for (const walkEntry of walkEntries) {
		onProgress?.("read-files", processed, totalFiles);
		processed++;

		const ext = extname(walkEntry.path).toLowerCase() || "";

		// Skip files that exceed the max size
		if (walkEntry.size > maxFileSize) {
			sizeSkipped++;
			continue;
		}

		const binary = isBinaryFile(walkEntry.path, ext);

		if (binary) {
			binarySkipped++;
			// Include binary entries in the tree but not in content
			fileEntries.push({
				path: walkEntry.path,
				relativePath: walkEntry.relativePath,
				size: walkEntry.size,
				ext,
				isBinary: true,
			});
			continue;
		}

		// Read text content
		let content: string;
		try {
			content = readFileSync(walkEntry.path, "utf-8");
		} catch {
			// Skip unreadable files
			binarySkipped++;
			continue;
		}

		const language = extensionToLanguage(ext);

		fileEntries.push({
			path: walkEntry.path,
			relativePath: walkEntry.relativePath,
			size: walkEntry.size,
			ext,
			isBinary: false,
			content,
			language,
		});
	}

	onProgress?.("read-files", totalFiles, totalFiles);

	// ─── Phase 4: Annotate token estimates ───────────────────────────────────
	onProgress?.("count-tokens", 0, 1);
	annotateTokenEstimates(fileEntries);
	onProgress?.("count-tokens", 1, 1);

	// ─── Phase 5: Build directory tree ───────────────────────────────────────
	onProgress?.("build-tree", 0, 1);
	const tree = buildTree(fileEntries);
	onProgress?.("build-tree", 1, 1);

	// ─── Phase 6: Build token report ─────────────────────────────────────────
	const tokenReport = buildTokenReport(fileEntries, tree);

	// ─── Phase 7: Format output ───────────────────────────────────────────────
	onProgress?.("format", 0, 1);

	const meta: PackMeta = {
		projectName: basename(projectPath),
		projectPath,
		generatedAt: new Date().toISOString(),
		version: getVersion(),
		fileCount: fileEntries.filter((e) => !e.isBinary).length,
		totalBytes: fileEntries.reduce((sum, e) => sum + e.size, 0),
		estimatedTokens: tokenReport.total,
		format,
	};

	let output: string;
	switch (format) {
		case "xml":
			output = formatXml(fileEntries, tree, meta);
			break;
		case "markdown":
			output = formatMarkdown(fileEntries, tree, meta);
			break;
		case "plain":
			output = formatPlain(fileEntries, tree, meta);
			break;
		default:
			output = formatXml(fileEntries, tree, meta);
	}

	onProgress?.("format", 1, 1);

	// ─── Phase 8: Write output ───────────────────────────────────────────────
	onProgress?.("write", 0, 1);

	if (options.stdout) {
		process.stdout.write(output);
		if (!output.endsWith("\n")) {
			process.stdout.write("\n");
		}
	} else if (options.outputPath) {
		const outputPath = resolve(options.outputPath);

		// Ensure output directory exists
		const outputDir = dirname(outputPath);
		if (!existsSync(outputDir)) {
			mkdirSync(outputDir, { recursive: true });
		}

		// Atomic write: write to .tmp then rename; clean up on error
		const tmpPath = outputPath + ".tmp";
		try {
			writeFileSync(tmpPath, output, "utf-8");
			renameSync(tmpPath, outputPath);
		} catch (err) {
			try {
				unlinkSync(tmpPath);
			} catch {
				// ignore cleanup errors
			}
			throw err;
		}
	}

	onProgress?.("write", 1, 1);

	const durationMs = Date.now() - startTime;

	return {
		outputPath: options.stdout ? undefined : options.outputPath,
		fileCount: meta.fileCount,
		binarySkipped,
		sizeSkipped,
		totalBytes: meta.totalBytes,
		estimatedTokens: tokenReport.total,
		durationMs,
		tokenReport: options.showTokens ? tokenReport : undefined,
	};
}
