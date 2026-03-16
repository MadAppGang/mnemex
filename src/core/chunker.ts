/**
 * AST-based Code Chunker
 *
 * Uses tree-sitter to parse code and extract semantic chunks
 * (functions, classes, methods) while preserving context.
 */

import { createHash } from "node:crypto";
import type { Node, Tree } from "web-tree-sitter";
import { getParserManager } from "../parsers/parser-manager.js";
import {
	isDocumentFormat,
	chunkDocument,
} from "../parsers/document-chunker.js";
import type {
	ChunkType,
	CodeChunk,
	ParsedChunk,
	SupportedLanguage,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum chunk size in tokens (approximate).
 * Research (2025-2026) shows 256-512 tokens optimal for RAG retrieval.
 * We use 600 as a safety cap since AST-aware chunking provides natural
 * boundaries — this only triggers on oversized constructs.
 * See: docs/adr/001-chunk-size-limits.md
 */
const MAX_CHUNK_TOKENS = 600;

/** Minimum chunk size in tokens */
const MIN_CHUNK_TOKENS = 50;

/** Characters per token estimate for code */
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Chunk Extraction
// ============================================================================

/**
 * Extract chunks from a source file
 */
export async function chunkFile(
	source: string,
	filePath: string,
	language: SupportedLanguage,
	fileHash: string,
): Promise<CodeChunk[]> {
	// Route document formats to document chunker
	if (isDocumentFormat(language)) {
		return chunkDocument(source, filePath, language as any, fileHash);
	}

	const parserManager = getParserManager();

	// Parse the source
	const tree = await parserManager.parse(source, language);
	if (!tree) {
		// Fallback to line-based chunking if parsing fails
		return fallbackChunk(source, filePath, language, fileHash);
	}

	// AST-pure chunking: every line belongs to exactly one chunk
	const parsedChunks = extractChunksAST(tree, source, language);

	// Convert to CodeChunk format — no MIN_CHUNK_TOKENS filter for AST chunks
	// (every AST-extracted chunk is semantically meaningful regardless of size)
	const chunks: CodeChunk[] = [];
	for (const parsed of parsedChunks) {
		chunks.push(createCodeChunk(parsed, filePath, language, fileHash));
	}

	// If no chunks were extracted, fall back to line-based chunking
	if (chunks.length === 0) {
		return fallbackChunk(source, filePath, language, fileHash);
	}

	return chunks;
}

/**
 * AST-pure chunk extraction.
 *
 * Design principle: every line of source code belongs to exactly one chunk.
 * Every chunk maps to an AST node (or connected group of sibling nodes).
 * No orphans. No blind splits.
 *
 * See: docs/adr/002-ast-pure-chunking.md
 */
function extractChunksAST(
	tree: Tree,
	source: string,
	language: SupportedLanguage,
): ParsedChunk[] {
	const chunks: ParsedChunk[] = [];
	processChildren(tree.rootNode, source, language, chunks, null);
	return chunks;
}

/**
 * Process children of a node, extracting chunks and absorbing gaps.
 *
 * For each child:
 * - If it's a recognized AST node that fits in MAX_CHUNK_TOKENS → emit as chunk
 * - If it's a recognized container (class/module) that's too large → descend into its body
 * - If it's a recognized non-container that's too large → split into connected parts
 * - Otherwise (imports, fields, comments, etc.) → accumulate as gap text
 *
 * Gap text (JSDoc, fields, imports) is attached to the next chunk or flushed standalone.
 */
function processChildren(
	parent: Node,
	source: string,
	language: SupportedLanguage,
	chunks: ParsedChunk[],
	containerName: string | null,
	initialPreamble?: string,
	initialPreambleStartLine?: number,
): void {
	const children: Node[] = [];
	for (let i = 0; i < parent.childCount; i++) {
		children.push(parent.child(i)!);
	}

	// Accumulator for gap lines (fields, comments, imports between chunks)
	let gapLines: string[] = initialPreamble ? [initialPreamble] : [];
	let gapStartLine = initialPreambleStartLine ?? -1;

	for (const child of children) {
		const content = source.slice(child.startIndex, child.endIndex);
		const tokens = estimateTokens(content);
		const chunkType = getChunkType(child.type, language);

		// Skip semicolons (typically on lines already covered by their statement)
		if (child.type === ";") continue;

		// JSDoc/comments → buffer, will attach to next chunk
		if (child.type === "comment") {
			if (gapStartLine < 0) gapStartLine = child.startPosition.row;
			gapLines.push(content);
			continue;
		}

		if (chunkType && tokens <= MAX_CHUNK_TOKENS && tokens >= MIN_CHUNK_TOKENS) {
			// Fits in one chunk AND big enough — emit with any buffered JSDoc/comments
			const fullContent =
				gapLines.length > 0 ? gapLines.join("\n") + "\n" + content : content;
			const startLine =
				gapStartLine >= 0 ? gapStartLine : child.startPosition.row;

			chunks.push({
				content: fullContent,
				startLine,
				endLine: child.endPosition.row,
				chunkType,
				name: extractName(child, language),
				parentName: containerName ?? extractParentName(child, language),
				signature: extractSignature(child, source, language),
			});
			gapLines = [];
			gapStartLine = -1;
		} else if (
			chunkType &&
			tokens <= MAX_CHUNK_TOKENS &&
			tokens < MIN_CHUNK_TOKENS
		) {
			// Recognized but too small to stand alone — check if gap + content is big enough
			const combinedContent =
				gapLines.length > 0 ? gapLines.join("\n") + "\n" + content : content;
			if (estimateTokens(combinedContent) >= MIN_CHUNK_TOKENS) {
				// Combined with gap, it's big enough — emit
				const startLine =
					gapStartLine >= 0 ? gapStartLine : child.startPosition.row;
				chunks.push({
					content: combinedContent,
					startLine,
					endLine: child.endPosition.row,
					chunkType,
					name: extractName(child, language),
					parentName: containerName ?? extractParentName(child, language),
					signature: extractSignature(child, source, language),
				});
				gapLines = [];
				gapStartLine = -1;
			} else {
				// Still too small even with gap — accumulate everything as gap
				if (gapStartLine < 0) gapStartLine = child.startPosition.row;
				gapLines.push(content);
			}
		} else if (chunkType && tokens > MAX_CHUNK_TOKENS) {
			// Too large — need to descend or split
			const name = extractName(child, language);
			const isContainer = chunkType === "class" || chunkType === "module";

			if (isContainer) {
				// For classes/modules: capture header + descend into body
				const body = child.childForFieldName("body") ?? child;

				// Include class header (everything before body) in the preamble
				// so "class Indexer {" isn't orphaned
				if (body !== child) {
					const headerContent = source
						.slice(child.startIndex, body.startIndex)
						.trimEnd();
					if (headerContent.trim().length > 0) {
						if (gapStartLine < 0) gapStartLine = child.startPosition.row;
						gapLines.push(headerContent);
					}
				}

				// Pass accumulated gap as preamble to class body processing
				// so it gets prepended to the first child chunk
				const preamble = gapLines.length > 0 ? gapLines.join("\n") : undefined;
				const preambleStart = gapStartLine;
				gapLines = [];
				gapStartLine = -1;

				processChildren(
					body,
					source,
					language,
					chunks,
					name ?? containerName,
					preamble,
					preambleStart,
				);
			} else {
				// For oversized functions/methods: include buffered JSDoc in the first part
				const preamble = gapLines.length > 0 ? gapLines.join("\n") : undefined;
				const preambleStartLine = gapStartLine >= 0 ? gapStartLine : -1;
				gapLines = [];
				gapStartLine = -1;

				splitIntoConnectedParts(
					child,
					source,
					language,
					containerName,
					chunks,
					preamble,
					preambleStartLine,
				);
			}
		} else {
			// Non-chunk node (import, field, export_statement, etc.)
			// Check if it wraps recognized children (e.g., export_statement wrapping class_declaration)
			if (hasRecognizedChild(child, language)) {
				flushGap(
					gapLines,
					gapStartLine,
					child.startPosition.row - 1,
					containerName,
					chunks,
				);
				gapLines = [];
				gapStartLine = -1;
				processChildren(child, source, language, chunks, containerName);
			} else {
				// Terminal gap node → accumulate
				if (gapStartLine < 0) gapStartLine = child.startPosition.row;
				gapLines.push(content);
			}
		}
	}

	// Flush remaining gap (trailing fields, etc.)
	if (gapLines.length > 0) {
		flushGap(
			gapLines,
			gapStartLine,
			parent.endPosition.row,
			containerName,
			chunks,
		);
	}
}

/**
 * Split an oversized leaf AST node into connected parts.
 * Each part is labeled (part K/N) and linked via partIndex/totalParts.
 * Optional preamble (JSDoc/comments) is prepended to the first part.
 */
function splitIntoConnectedParts(
	node: Node,
	source: string,
	language: SupportedLanguage,
	containerName: string | null,
	chunks: ParsedChunk[],
	preamble?: string,
	preambleStartLine?: number,
): void {
	const content = source.slice(node.startIndex, node.endIndex);
	const lines = content.split("\n");
	const maxLines = Math.floor((MAX_CHUNK_TOKENS * CHARS_PER_TOKEN) / 80);
	const name = extractName(node, language);
	const chunkType = getChunkType(node.type, language)!;

	// Build split boundaries, merging a tiny last part into the previous one.
	// Without this, the last part can be just 2-3 closing braces — not a
	// meaningful chunk (no callers, no summary, useless search result).
	const MIN_LAST_PART_LINES = 10;
	const boundaries: Array<{ start: number; end: number }> = [];
	for (let start = 0; start < lines.length; start += maxLines) {
		boundaries.push({ start, end: Math.min(start + maxLines, lines.length) });
	}
	// Merge tiny last part into previous
	if (boundaries.length >= 2) {
		const last = boundaries[boundaries.length - 1];
		if (last.end - last.start < MIN_LAST_PART_LINES) {
			boundaries[boundaries.length - 2].end = last.end;
			boundaries.pop();
		}
	}

	const totalParts = boundaries.length;

	for (let p = 0; p < totalParts; p++) {
		const { start, end } = boundaries[p];
		let partContent = lines.slice(start, end).join("\n");
		let startLine = node.startPosition.row + start;

		// Prepend JSDoc/comment preamble to first part
		if (p === 0 && preamble) {
			partContent = preamble + "\n" + partContent;
			if (preambleStartLine != null && preambleStartLine >= 0) {
				startLine = preambleStartLine;
			}
		}

		chunks.push({
			content: partContent,
			startLine,
			endLine: node.startPosition.row + end - 1,
			chunkType,
			name: name ? `${name} (part ${p + 1}/${totalParts})` : undefined,
			parentName: containerName ?? extractParentName(node, language),
			signature: p === 0 ? extractSignature(node, source, language) : undefined,
			partIndex: p + 1,
			totalParts,
		});
	}
}

/**
 * Flush accumulated gap lines as a standalone chunk.
 * Gaps are imports, field declarations, static properties, etc. that
 * sit between recognized AST chunks.
 */
function flushGap(
	lines: string[],
	startLine: number,
	endLine: number,
	containerName: string | null,
	chunks: ParsedChunk[],
): void {
	if (lines.length === 0) return;
	const content = lines.join("\n");
	if (content.trim().length < 10) return; // Skip trivial gaps

	chunks.push({
		content,
		startLine,
		endLine,
		chunkType: "module", // imports, fields, declarations → module-level
		name: containerName ? `${containerName} (fields)` : undefined,
		parentName: containerName ?? undefined,
	});
}

/**
 * Check if a node has any direct children with recognized chunk types.
 * Used to detect wrapper nodes like export_statement that contain
 * class_declaration, function_declaration, etc.
 */
function hasRecognizedChild(node: Node, language: SupportedLanguage): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i)!;
		if (getChunkType(child.type, language) !== null) return true;
	}
	return false;
}

/**
 * Map AST node type to chunk type
 */
function getChunkType(
	nodeType: string,
	language: SupportedLanguage,
): ChunkType | null {
	// Document sections (handled by document-chunker)
	if (["atx_heading", "section"].includes(nodeType)) {
		return "document-section" as any;
	}

	// CSS rulesets
	if (nodeType === "rule_set") {
		return "stylesheet-rule" as any;
	}

	// GraphQL types
	if (["type_definition", "interface_definition"].includes(nodeType)) {
		return "type" as any;
	}

	// Shell functions
	if (nodeType === "function_definition" && language === "bash") {
		return "shell-function" as any;
	}

	// GraphQL queries
	if (nodeType === "query") {
		return "query" as any;
	}

	// Function types
	const functionTypes = [
		"function_declaration",
		"function_definition",
		"function_item",
		"arrow_function",
		"method_declaration",
	];

	// Class types
	const classTypes = [
		"class_declaration",
		"class_definition",
		"class_specifier",
		"struct_item",
		"struct_specifier",
		"interface_declaration",
		"trait_item",
		"impl_item",
	];

	// Method types
	const methodTypes = ["method_definition", "method_declaration"];

	// Module-level types
	const moduleTypes = [
		"type_alias_declaration",
		"enum_item",
		"enum_declaration",
		"enum_specifier",
	];

	if (methodTypes.includes(nodeType)) {
		return "method";
	}
	if (functionTypes.includes(nodeType)) {
		return "function";
	}
	if (classTypes.includes(nodeType)) {
		return "class";
	}
	if (moduleTypes.includes(nodeType)) {
		return "module";
	}

	return null;
}

/**
 * Extract name from AST node
 */
function extractName(
	node: Node,
	language: SupportedLanguage,
): string | undefined {
	// Try different name field patterns
	const namePatterns = ["name", "declarator"];

	for (const pattern of namePatterns) {
		const nameNode = node.childForFieldName(pattern);
		if (nameNode) {
			// Handle nested declarators (e.g., C function_declarator)
			if (nameNode.type.includes("declarator")) {
				const innerName = nameNode.childForFieldName("declarator");
				if (innerName) {
					return innerName.text;
				}
			}
			return nameNode.text;
		}
	}

	// For Go method declarations
	if (node.type === "method_declaration") {
		const nameNode = node.childForFieldName("name");
		if (nameNode) {
			return nameNode.text;
		}
	}

	return undefined;
}

/**
 * Extract parent class name for methods
 */
function extractParentName(
	node: Node,
	language: SupportedLanguage,
): string | undefined {
	// For method definitions inside classes
	if (node.type === "method_definition" || node.type === "method_declaration") {
		let parent = node.parent;
		while (parent) {
			if (
				parent.type === "class_declaration" ||
				parent.type === "class_definition" ||
				parent.type === "class_body"
			) {
				const classNode = parent.type === "class_body" ? parent.parent : parent;
				if (classNode) {
					const nameNode = classNode.childForFieldName("name");
					if (nameNode) {
						return nameNode.text;
					}
				}
			}
			parent = parent.parent;
		}
	}

	// For Rust impl blocks
	if (language === "rust" && node.type === "impl_item") {
		const typeNode = node.childForFieldName("type");
		if (typeNode) {
			return typeNode.text;
		}
	}

	// For Go methods (receiver type)
	if (language === "go" && node.type === "method_declaration") {
		const receiverNode = node.childForFieldName("receiver");
		if (receiverNode) {
			// Extract type from receiver
			const typeNode = receiverNode.descendantsOfType("type_identifier")[0];
			if (typeNode) {
				return typeNode.text;
			}
		}
	}

	return undefined;
}

/**
 * Extract function/method signature
 */
function extractSignature(
	node: Node,
	source: string,
	language: SupportedLanguage,
): string | undefined {
	// Get the first line or up to the opening brace
	const content = source.slice(node.startIndex, node.endIndex);
	const lines = content.split("\n");

	if (lines.length === 0) {
		return undefined;
	}

	// Find the signature (everything before the body)
	let signature = lines[0].trim();

	// For multi-line signatures, try to find the complete signature
	for (let i = 1; i < Math.min(lines.length, 5); i++) {
		const line = lines[i].trim();
		if (line.startsWith("{") || line.startsWith(":")) {
			break;
		}
		if (line.includes("{") || line.includes(":")) {
			// Include up to the brace/colon
			const braceIdx = Math.min(
				line.indexOf("{") >= 0 ? line.indexOf("{") : Infinity,
				line.indexOf(":") >= 0 ? line.indexOf(":") : Infinity,
			);
			signature += " " + line.slice(0, braceIdx).trim();
			break;
		}
		signature += " " + line;
	}

	// Clean up signature
	signature = signature.replace(/\s+/g, " ").trim();

	// Limit length
	if (signature.length > 200) {
		signature = signature.slice(0, 197) + "...";
	}

	return signature || undefined;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a CodeChunk from parsed chunk data
 */
function createCodeChunk(
	parsed: ParsedChunk,
	filePath: string,
	language: SupportedLanguage,
	fileHash: string,
): CodeChunk {
	// Storage ID: includes position for uniqueness within a file
	// Include filePath and line range in hash to prevent collisions across files
	// with identical content (e.g., boilerplate functions)
	const hashInput = `${filePath}:${parsed.startLine}:${parsed.endLine}:${parsed.content}`;
	const id = createHash("sha256").update(hashInput).digest("hex");

	// Content hash: stable identifier for diffing (ignores line numbers)
	// Used to detect unchanged content even when lines shift
	// Includes name+type+content to differentiate similar code with different purposes
	const contentHashInput = `${parsed.name || ""}:${parsed.chunkType}:${parsed.content}`;
	const contentHash = createHash("sha256")
		.update(contentHashInput)
		.digest("hex");

	return {
		id,
		contentHash,
		content: parsed.content,
		filePath,
		startLine: parsed.startLine + 1, // Convert to 1-indexed
		endLine: parsed.endLine + 1,
		language,
		chunkType: parsed.chunkType,
		name: parsed.name,
		parentName: parsed.parentName,
		signature: parsed.signature,
		fileHash,
		partIndex: parsed.partIndex,
		totalParts: parsed.totalParts,
	};
}

/**
 * Estimate tokens in text
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Fallback line-based chunking for unsupported languages
 */
function fallbackChunk(
	source: string,
	filePath: string,
	language: string,
	fileHash: string,
): CodeChunk[] {
	const lines = source.split("\n");
	const maxLinesPerChunk = Math.floor(
		(MAX_CHUNK_TOKENS * CHARS_PER_TOKEN) / 80,
	);

	const chunks: CodeChunk[] = [];
	let currentLines: string[] = [];
	let currentStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		currentLines.push(lines[i]);

		if (currentLines.length >= maxLinesPerChunk) {
			const content = currentLines.join("\n");
			if (content.trim().length >= MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) {
				const startLine = currentStartLine + 1;
				const endLine = i + 1;
				const hashInput = `${filePath}:${startLine}:${endLine}:${content}`;
				const id = createHash("sha256").update(hashInput).digest("hex");
				// Content hash for diffing (stable across line shifts)
				const contentHashInput = `:block:${content}`;
				const contentHash = createHash("sha256")
					.update(contentHashInput)
					.digest("hex");
				chunks.push({
					id,
					contentHash,
					content,
					filePath,
					startLine,
					endLine,
					language,
					chunkType: "block",
					fileHash,
				});
			}

			currentLines = [];
			currentStartLine = i + 1;
		}
	}

	// Add remaining lines
	if (currentLines.length > 0) {
		const content = currentLines.join("\n");
		if (content.trim().length >= MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) {
			const startLine = currentStartLine + 1;
			const endLine = lines.length;
			const hashInput = `${filePath}:${startLine}:${endLine}:${content}`;
			const id = createHash("sha256").update(hashInput).digest("hex");
			// Content hash for diffing (stable across line shifts)
			const contentHashInput = `:block:${content}`;
			const contentHash = createHash("sha256")
				.update(contentHashInput)
				.digest("hex");
			chunks.push({
				id,
				contentHash,
				content,
				filePath,
				startLine,
				endLine,
				language,
				chunkType: "block",
				fileHash,
			});
		}
	}

	return chunks;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Chunk a file by path
 */
export async function chunkFileByPath(
	source: string,
	filePath: string,
	fileHash: string,
): Promise<CodeChunk[]> {
	const parserManager = getParserManager();
	const language = parserManager.getLanguage(filePath);

	if (!language) {
		// Unsupported language - use fallback chunking
		const ext = filePath.split(".").pop() || "unknown";
		return fallbackChunk(source, filePath, ext, fileHash);
	}

	return chunkFile(source, filePath, language, fileHash);
}

/**
 * Check if a file can be chunked
 */
export function canChunkFile(filePath: string): boolean {
	const parserManager = getParserManager();
	return parserManager.isSupported(filePath);
}
