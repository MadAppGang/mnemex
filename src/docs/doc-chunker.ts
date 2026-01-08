/**
 * Documentation Chunker
 *
 * Chunks fetched documentation into embeddable pieces and classifies
 * their document type based on content patterns.
 */

import { createHash } from "node:crypto";
import type { DocProviderType, DocumentType } from "../types.js";
import type { DocChunk, FetchedDoc } from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

/** Target chunk size in characters */
const TARGET_CHUNK_SIZE = 1500;

/** Maximum chunk size (hard limit) */
const MAX_CHUNK_SIZE = 2500;

/** Minimum chunk size (avoid tiny chunks) */
const MIN_CHUNK_SIZE = 200;

// ============================================================================
// Classification Patterns
// ============================================================================

/** Patterns indicating API reference documentation */
const API_REFERENCE_PATTERNS = [
	/\bfunction\s+\w+\s*\(/i,
	/\bclass\s+\w+/i,
	/\binterface\s+\w+/i,
	/\btype\s+\w+\s*=/i,
	/\bdef\s+\w+\s*\(/i,
	/\bfunc\s+\w+\s*\(/i,
	/\bfn\s+\w+\s*\(/i,
	/\bParameters\s*:/i,
	/\bReturns\s*:/i,
	/\bArguments\s*:/i,
	/\bReturn\s+value/i,
	/\|\s*Parameter\s*\|/i, // Markdown tables
	/\|\s*Name\s*\|\s*Type\s*\|/i,
	/@param\s+/i,
	/@returns?\s+/i,
	/@type\s+/i,
	/```\w+\n.*\n```/s, // Code blocks
];

/** Patterns indicating best practices documentation */
const BEST_PRACTICE_PATTERNS = [
	/\bshould\b/i,
	/\bshould\s+not\b/i,
	/\bavoid\b/i,
	/\bdon't\b/i,
	/\bdo\s+not\b/i,
	/\brecommend/i,
	/\bprefer\b/i,
	/\bbest\s+practice/i,
	/\bguideline/i,
	/\banti[- ]?pattern/i,
	/\bpit\s*fall/i,
	/\bcommon\s+mistake/i,
	/\binstead\s+of\b/i,
	/\brather\s+than\b/i,
	/\bbetter\s+to\b/i,
	/\bwarning\b/i,
	/\bcaution\b/i,
	/⚠️|❌|✅|💡/,
];

// ============================================================================
// Doc Chunker Class
// ============================================================================

export class DocChunker {
	/**
	 * Chunk and classify a single fetched document
	 */
	chunk(
		doc: FetchedDoc,
		metadata: {
			provider: DocProviderType;
			library: string;
			version?: string;
		},
	): DocChunk[] {
		const chunks: DocChunk[] = [];

		// Split content into chunks
		const contentChunks = this.splitContent(doc.content, doc.title);

		for (let i = 0; i < contentChunks.length; i++) {
			const chunkContent = contentChunks[i];

			// Skip empty or too-small chunks
			if (chunkContent.length < MIN_CHUNK_SIZE) {
				continue;
			}

			// Classify the chunk
			const documentType = this.classifyType(chunkContent);

			// Generate unique ID
			const id = this.generateChunkId(
				metadata.library,
				doc.id,
				i,
				chunkContent,
			);

			chunks.push({
				id,
				content: chunkContent,
				title: doc.title,
				section: doc.section,
				documentType,
				provider: metadata.provider,
				library: metadata.library,
				version: metadata.version,
				sourceUrl: doc.url,
			});
		}

		return chunks;
	}

	/**
	 * Chunk multiple documents
	 */
	chunkAll(
		docs: FetchedDoc[],
		metadata: {
			provider: DocProviderType;
			library: string;
			version?: string;
		},
	): DocChunk[] {
		return docs.flatMap((doc) => this.chunk(doc, metadata));
	}

	/**
	 * Split content into appropriately sized chunks
	 * Uses semantic boundaries (paragraphs, headers) when possible
	 */
	private splitContent(content: string, title: string): string[] {
		const chunks: string[] = [];

		// If content is small enough, return as single chunk
		if (content.length <= TARGET_CHUNK_SIZE) {
			return [this.formatChunk(title, content)];
		}

		// Split by semantic boundaries
		const sections = this.splitByBoundaries(content);

		let currentChunk = "";

		for (const section of sections) {
			// If section alone exceeds max, split it further
			if (section.length > MAX_CHUNK_SIZE) {
				// Flush current chunk first
				if (currentChunk) {
					chunks.push(this.formatChunk(title, currentChunk));
					currentChunk = "";
				}

				// Split large section by sentences
				const sentences = this.splitBySentences(section);
				for (const sentence of sentences) {
					if (currentChunk.length + sentence.length > TARGET_CHUNK_SIZE) {
						if (currentChunk) {
							chunks.push(this.formatChunk(title, currentChunk));
						}
						currentChunk = sentence;
					} else {
						currentChunk += (currentChunk ? " " : "") + sentence;
					}
				}
			}
			// If adding section exceeds target, start new chunk
			else if (currentChunk.length + section.length > TARGET_CHUNK_SIZE) {
				chunks.push(this.formatChunk(title, currentChunk));
				currentChunk = section;
			}
			// Add section to current chunk
			else {
				currentChunk += (currentChunk ? "\n\n" : "") + section;
			}
		}

		// Don't forget the last chunk
		if (currentChunk) {
			chunks.push(this.formatChunk(title, currentChunk));
		}

		return chunks;
	}

	/**
	 * Split content by semantic boundaries (headers, paragraphs, code blocks)
	 */
	private splitByBoundaries(content: string): string[] {
		const sections: string[] = [];
		let currentSection = "";

		const lines = content.split("\n");
		let inCodeBlock = false;

		for (const line of lines) {
			// Track code blocks
			if (line.startsWith("```")) {
				inCodeBlock = !inCodeBlock;
			}

			// Headers start new sections (unless in code block)
			if (!inCodeBlock && /^#{1,6}\s+/.test(line)) {
				if (currentSection.trim()) {
					sections.push(currentSection.trim());
				}
				currentSection = line;
			}
			// Double newlines create paragraph breaks
			else if (line === "" && currentSection.endsWith("\n\n")) {
				// Already have double newline, skip
			}
			// Add line to current section
			else {
				currentSection += (currentSection ? "\n" : "") + line;
			}
		}

		// Don't forget last section
		if (currentSection.trim()) {
			sections.push(currentSection.trim());
		}

		return sections;
	}

	/**
	 * Split text by sentences (fallback for large sections)
	 */
	private splitBySentences(text: string): string[] {
		// Simple sentence splitting - handles common patterns
		return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
	}

	/**
	 * Format a chunk with title context
	 */
	private formatChunk(title: string, content: string): string {
		// Only add title if content doesn't already start with it
		if (content.startsWith(`# ${title}`) || content.startsWith(`## ${title}`)) {
			return content;
		}
		return `# ${title}\n\n${content}`;
	}

	/**
	 * Classify content as framework_doc, best_practice, or api_reference
	 */
	classifyType(content: string): DocumentType {
		// Count pattern matches
		let apiScore = 0;
		let practiceScore = 0;

		for (const pattern of API_REFERENCE_PATTERNS) {
			if (pattern.test(content)) apiScore++;
		}

		for (const pattern of BEST_PRACTICE_PATTERNS) {
			if (pattern.test(content)) practiceScore++;
		}

		// Threshold-based classification
		if (apiScore >= 3) return "api_reference";
		if (practiceScore >= 2) return "best_practice";

		// Default to framework_doc
		return "framework_doc";
	}

	/**
	 * Generate a unique chunk ID
	 */
	private generateChunkId(
		library: string,
		docId: string,
		index: number,
		content: string,
	): string {
		const hash = createHash("md5")
			.update(`${library}:${docId}:${index}:${content.slice(0, 100)}`)
			.digest("hex")
			.slice(0, 8);

		return `doc:${library}:${hash}`;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a DocChunker instance
 */
export function createDocChunker(): DocChunker {
	return new DocChunker();
}
