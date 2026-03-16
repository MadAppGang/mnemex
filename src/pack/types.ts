/**
 * Pack Types
 *
 * Type definitions for the mnemex pack command.
 */

// ============================================================================
// Core Types
// ============================================================================

/** Output format for the packed file */
export type OutputFormat = "xml" | "markdown" | "plain";

/** A single file entry discovered during pack */
export interface FileEntry {
	/** Absolute path to the file */
	path: string;
	/** Path relative to project root */
	relativePath: string;
	/** File size in bytes */
	size: number;
	/** File extension including dot (e.g., ".ts") */
	ext: string;
	/** Whether the file is binary */
	isBinary: boolean;
	/** File content (undefined for binary files) */
	content?: string;
	/** Estimated token count for this file's content */
	estimatedTokens?: number;
	/** Language identifier for syntax highlighting */
	language?: string;
}

/** Metadata about the pack operation */
export interface PackMeta {
	/** Project name (basename of project path) */
	projectName: string;
	/** Absolute path to project root */
	projectPath: string;
	/** ISO timestamp when pack was generated */
	generatedAt: string;
	/** mnemex version */
	version: string;
	/** Total number of files included */
	fileCount: number;
	/** Total bytes of all included files */
	totalBytes: number;
	/** Estimated total token count */
	estimatedTokens: number;
	/** Output format used */
	format: OutputFormat;
}

/** Token estimate report */
export interface TokenReport {
	/** Total estimated tokens */
	total: number;
	/** Tokens from file contents */
	contentTokens: number;
	/** Tokens from structure/headers */
	structureTokens: number;
	/** Per-file token estimates */
	byFile: Array<{ relativePath: string; tokens: number }>;
}

/** Options for the pack command */
export interface PackOptions {
	/** Root directory to pack (default: cwd) */
	projectPath: string;
	/** Output file path (undefined = stdout) */
	outputPath?: string;
	/** Output format (default: xml) */
	format: OutputFormat;
	/** Glob patterns for files to include (default: all text files) */
	includePatterns: string[];
	/** Additional glob patterns to exclude beyond defaults */
	excludePatterns: string[];
	/** Whether to respect .gitignore (default: true) */
	useGitignore: boolean;
	/** Maximum file size to include in bytes (default: 1MB) */
	maxFileSize: number;
	/** Whether to write to stdout instead of a file */
	stdout: boolean;
	/** Whether to show token count report */
	showTokens: boolean;
}

/** Result from a pack operation */
export interface PackResult {
	/** Path to the output file (undefined if stdout mode) */
	outputPath?: string;
	/** Number of files included */
	fileCount: number;
	/** Number of binary files skipped */
	binarySkipped: number;
	/** Number of files skipped due to size */
	sizeSkipped: number;
	/** Total bytes of included file contents */
	totalBytes: number;
	/** Estimated token count */
	estimatedTokens: number;
	/** Duration of the operation in milliseconds */
	durationMs: number;
	/** Token report (if requested) */
	tokenReport?: TokenReport;
}

/** File metadata for native file stats */
export interface NativeFileMetadata {
	/** File size in bytes */
	size: number;
	/** Last modified time */
	mtime: Date;
}
