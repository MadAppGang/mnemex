/**
 * Code Unit Extractor
 *
 * Extracts hierarchical code units from source files with parent-child relationships.
 * Builds on tree-sitter AST parsing and integrates with the metadata extractor.
 *
 * Key features:
 * - Hierarchical extraction (file → class → method)
 * - Parent-child relationships via parentId
 * - Depth tracking for bottom-up processing
 * - Rich AST metadata extraction
 */

import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import {
	getParserManager,
	type ParserManager,
} from "../../parsers/parser-manager.js";
import type {
	ASTMetadata,
	CodeUnit,
	SupportedLanguage,
	UnitType,
} from "../../types.js";
import {
	ASTMetadataExtractor,
	type ExtractionContext,
} from "./metadata-extractor.js";

// ============================================================================
// Types
// ============================================================================

export interface ExtractionOptions {
	/** Include file-level unit (default: true) */
	includeFile?: boolean;
	/** Maximum depth to extract (default: unlimited) */
	maxDepth?: number;
	/** Minimum content length to include (default: 10) */
	minContentLength?: number;
}

interface ExtractedUnit {
	node: Node;
	unitType: UnitType;
	name?: string;
	parentId: string | null;
	depth: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Map AST node types to unit types */
const NODE_TYPE_TO_UNIT_TYPE: Record<string, UnitType> = {
	// Functions
	function_declaration: "function",
	function_definition: "function", // Python - may be reclassified as method if inside class
	function_item: "function",
	arrow_function: "function",
	function_expression: "function",
	// Classes
	class_declaration: "class",
	class_definition: "class",
	class_specifier: "class",
	// Interfaces
	interface_declaration: "interface",
	// Methods
	method_definition: "method",
	method_declaration: "method", // Go receiver methods
	// Types
	type_alias_declaration: "type",
	// Note: type_declaration handled specially for Go (can contain struct/interface)
	// Enums
	enum_declaration: "enum",
	enum_item: "enum",
	enum_specifier: "enum",
	// Structs (treated as classes for consistency)
	struct_item: "class",
	struct_specifier: "class",
	// Go-specific: type_spec is handled specially based on child type
	type_spec: "type", // Will be reclassified based on struct_type/interface_type child
	// Rust traits/impls
	trait_item: "interface",
	impl_item: "class",
};

/** Node types that can contain children we want to extract */
const CONTAINER_TYPES = new Set([
	"class_declaration",
	"class_definition",
	"class_body",
	"class_specifier",
	"interface_declaration",
	"interface_body",
	"struct_item",
	"struct_specifier",
	"trait_item",
	"impl_item",
	"enum_declaration",
	"enum_body",
	"module",
	"program",
	"source_file",
	"block",
	"statement_block",
	// Go-specific containers
	"type_declaration", // Contains type_spec children
]);

// ============================================================================
// The two keys of a code unit (decision I-14)
// ============================================================================

/**
 * THE POSITIONAL SOURCE both keys are built from: path, type, name, start row.
 * `filePath` is the STORED path, because the ids hash it and a stored row is
 * what a later run compares against.
 */
function positionSource(
	filePath: string,
	unitType: string,
	name: string | undefined,
	startRow: number,
): string {
	return `${filePath}:${unitType}:${name || "anon"}:${startRow}`;
}

const sha16 = (source: string): string =>
	createHash("sha256").update(source).digest("hex").slice(0, 16);

/**
 * THE PARENT-LINK KEY — position only, deliberately NO content (I-14).
 *
 * It is a REFERENCE, and a reference must survive an edit inside the thing it
 * points at. It is therefore **not** a row id and must never be compared with
 * one: `getChildUnits` takes this key, and `CodeUnitExtractor.getChildren` /
 * `getParent` join on it.
 *
 * WHY THE TWO KEYS ARE NOT ONE, measured rather than argued. Before I-14 the
 * link WAS the parent's row id, and the id namespace and the link namespace
 * coincided. That looked tidy and degraded in the store: a child whose own
 * content did not change is a tier-1 hit and is never rewritten, so when its
 * parent's id moved the child kept pointing at a row that had been narrowed
 * away. Measured on the real indexer, one in-place body edit in a 7-unit file:
 * **2 of 6 stored links named no live row** — and the file-level unit, whose id
 * has always hashed the file hash, is the parent of every top-level unit, so
 * that decay happened on EVERY edit. Making the link positional removes it by
 * construction: the key of a unit that did not move does not move.
 *
 * The cost I-14 feared — "one keystroke rewrites every unit in the file" —
 * was never real in either direction: `parentId` is not part of the tier-1 hit
 * test, so a changed link rewrites nothing. What it changes is whether the
 * stored link still resolves.
 */
export function codeUnitParentKey(
	filePath: string,
	unitType: string,
	name: string | undefined,
	startRow: number,
): string {
	return sha16(positionSource(filePath, unitType, name, startRow));
}

/**
 * THE PARENT-LINK KEY of a unit that has already been built or read back.
 * `startLine` is 1-indexed and the key hashes the 0-indexed start row.
 *
 * The `filePath` here must be the STORED path. A `CodeUnit` handed back by
 * `VectorStore` carries the path a CALLER sees (`fromStoredPath`, D4), so a
 * caller reading rows out of the store converts before calling this — which is
 * why `VectorStore.getChildUnits` takes the rendered key rather than a unit.
 */
export function codeUnitParentKeyOf(unit: {
	filePath: string;
	unitType: string;
	name?: string;
	startLine: number;
}): string {
	return codeUnitParentKey(
		unit.filePath,
		unit.unitType,
		unit.name,
		unit.startLine - 1,
	);
}

/**
 * THE ROW ID — position AND content (I-14). Identity, not reference.
 *
 * Two revisions of one function at one start line must be able to coexist as
 * two rows, so that each branch's membership can point at its own. Without the
 * content hash they collided on one id and the branch that indexed LAST decided
 * the body every branch saw — a V3.3 violation, which is what I-14 rules out.
 *
 * §4.1.1 licenses widening on an id match because "chunk ids are
 * content+position addressed". That was true of `code_chunk` and false of
 * `code_unit`; after this it is true of both, and the code-unit special case in
 * the tier-1 hit test drops to a belt (see `VectorStore.refreshCodeUnits`).
 */
export function codeUnitRowId(
	filePath: string,
	unitType: string,
	name: string | undefined,
	startRow: number,
	content: string,
): string {
	const contentHash = createHash("sha256").update(content).digest("hex");
	return sha16(
		`${positionSource(filePath, unitType, name, startRow)}:${contentHash}`,
	);
}

// ============================================================================
// Code Unit Extractor Class
// ============================================================================

export class CodeUnitExtractor {
	private parserManager: ParserManager;
	private metadataExtractor: ASTMetadataExtractor;

	constructor() {
		this.parserManager = getParserManager();
		this.metadataExtractor = new ASTMetadataExtractor();
	}

	/**
	 * Extract all code units from a source file
	 */
	async extractUnits(
		source: string,
		filePath: string,
		language: SupportedLanguage,
		fileHash: string,
		options: ExtractionOptions = {},
	): Promise<CodeUnit[]> {
		const { includeFile = true, maxDepth, minContentLength = 10 } = options;

		// Parse the source
		const tree = await this.parserManager.parse(source, language);
		if (!tree) {
			// Return file-level unit only if parsing fails
			if (includeFile) {
				return [this.createFileUnit(source, filePath, language, fileHash)];
			}
			return [];
		}

		const units: CodeUnit[] = [];
		const ctx: ExtractionContext = { filePath, source, language };

		// Add file-level unit
		//
		// The children are linked to the file unit's PARENT KEY, not to its row
		// id (I-14). The file unit's id hashes `fileHash`, so it moves on every
		// edit anywhere in the file — which is precisely the churn the link must
		// not inherit, and was the whole of the decay measured before this change.
		let fileUnitKey: string | null = null;
		if (includeFile) {
			const fileUnit = this.createFileUnit(
				source,
				filePath,
				language,
				fileHash,
			);
			units.push(fileUnit);
			fileUnitKey = codeUnitParentKeyOf(fileUnit);
		}

		// Extract hierarchical units from AST (now passing filePath and language for consistent ID generation)
		const extractedUnits = this.walkAndExtract(
			tree.rootNode,
			fileUnitKey,
			1,
			maxDepth,
			source,
			filePath,
			language,
		);

		// Convert to CodeUnit format
		for (const extracted of extractedUnits) {
			const content = source.slice(
				extracted.node.startIndex,
				extracted.node.endIndex,
			);

			// Skip tiny units
			if (content.trim().length < minContentLength) {
				continue;
			}

			const name = extracted.name || this.extractName(extracted.node, language);
			const signature = this.extractSignature(extracted.node, source);
			const metadata = this.metadataExtractor.extractMetadata(
				extracted.node,
				ctx,
			);

			const unit = this.createCodeUnit({
				node: extracted.node,
				unitType: extracted.unitType,
				name,
				signature,
				content,
				filePath,
				language,
				fileHash,
				parentId: extracted.parentId,
				depth: extracted.depth,
				metadata,
			});

			units.push(unit);
		}

		return units;
	}

	/**
	 * Walk AST and extract units with hierarchy
	 * Fixed: Now passes filePath and language through recursion for consistent ID generation
	 * Enhanced: Context-aware type detection for Python methods and Go structs/interfaces
	 */
	private walkAndExtract(
		node: Node,
		parentId: string | null,
		currentDepth: number,
		maxDepth: number | undefined,
		source: string,
		filePath: string,
		language: SupportedLanguage,
	): ExtractedUnit[] {
		const results: ExtractedUnit[] = [];

		// Check depth limit
		if (maxDepth !== undefined && currentDepth > maxDepth) {
			return results;
		}

		// Check if this node is a unit we want to extract
		let unitType = NODE_TYPE_TO_UNIT_TYPE[node.type];

		// Context-aware type detection
		if (unitType) {
			unitType = this.refineUnitType(node, unitType, language);
		}

		if (unitType) {
			// This is a code unit - extract it and use it as parent for children
			const name = this.extractName(node, language);
			// The children's link is this unit's PARENT KEY (I-14), which is
			// derivable without its content — deliberately, because the content is
			// what churns. `createCodeUnit` below gives the unit a DIFFERENT value
			// for its own row id, and the two must not be confused.
			const unitKey = codeUnitParentKey(
				filePath,
				unitType,
				name,
				node.startPosition.row,
			);

			results.push({
				node,
				unitType,
				name,
				parentId,
				depth: currentDepth,
			});

			// Continue extracting children with this unit as parent
			const childResults = this.extractChildren(
				node,
				unitKey,
				currentDepth + 1,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		} else if (CONTAINER_TYPES.has(node.type)) {
			// This is a container - extract children with current parent
			const childResults = this.extractChildren(
				node,
				parentId,
				currentDepth,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		} else {
			// Regular node - check children
			const childResults = this.extractChildren(
				node,
				parentId,
				currentDepth,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		}

		return results;
	}

	/**
	 * Refine unit type based on context
	 * - Python function_definition inside class → method
	 * - Go type_spec with struct_type → class
	 * - Go type_spec with interface_type → interface
	 */
	private refineUnitType(
		node: Node,
		baseType: UnitType,
		language: SupportedLanguage,
	): UnitType {
		// Python: function inside class is a method
		if (language === "python" && node.type === "function_definition") {
			if (this.isInsideClass(node)) {
				return "method";
			}
		}

		// Go: type_spec - check child type
		if (language === "go" && node.type === "type_spec") {
			// Look for struct_type or interface_type child
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "struct_type") {
					return "class";
				}
				if (child?.type === "interface_type") {
					return "interface";
				}
			}
			// Fall back to "type" for type aliases
			return "type";
		}

		return baseType;
	}

	/**
	 * Check if a node is inside a class definition
	 */
	private isInsideClass(node: Node): boolean {
		let current = node.parent;
		while (current) {
			if (
				current.type === "class_definition" ||
				current.type === "class_declaration"
			) {
				return true;
			}
			current = current.parent;
		}
		return false;
	}

	/**
	 * Extract children of a node
	 */
	private extractChildren(
		node: Node,
		parentId: string | null,
		currentDepth: number,
		maxDepth: number | undefined,
		source: string,
		filePath: string,
		language: SupportedLanguage,
	): ExtractedUnit[] {
		const results: ExtractedUnit[] = [];

		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child) {
				const childResults = this.walkAndExtract(
					child,
					parentId,
					currentDepth,
					maxDepth,
					source,
					filePath,
					language,
				);
				results.push(...childResults);
			}
		}

		return results;
	}

	/**
	 * Create a file-level code unit
	 *
	 * Its row id has ALWAYS carried content — `fileHash` is the file's content
	 * hash — so I-14's rule is already satisfied here and the formula is left
	 * alone. It is the one unit whose row id is not `codeUnitRowId`'s; its
	 * PARENT KEY is the ordinary `codeUnitParentKey(path, "file", basename, 0)`,
	 * which is what its children link to.
	 */
	private createFileUnit(
		source: string,
		filePath: string,
		language: SupportedLanguage,
		fileHash: string,
	): CodeUnit {
		const lines = source.split("\n");
		const id = createHash("sha256")
			.update(`file:${filePath}:${fileHash}`)
			.digest("hex")
			.slice(0, 16);

		return {
			id,
			parentId: null,
			unitType: "file",
			filePath,
			startLine: 1,
			endLine: lines.length,
			language,
			content: source,
			name: filePath.split("/").pop(),
			fileHash,
			depth: 0,
		};
	}

	/**
	 * Create a code unit from extracted data
	 */
	private createCodeUnit(data: {
		node: Node;
		unitType: UnitType;
		name?: string;
		signature?: string;
		content: string;
		filePath: string;
		language: SupportedLanguage;
		fileHash: string;
		parentId: string | null;
		depth: number;
		metadata?: ASTMetadata;
	}): CodeUnit {
		const {
			node,
			unitType,
			name,
			signature,
			content,
			filePath,
			language,
			fileHash,
			parentId,
			depth,
			metadata,
		} = data;

		// THE ROW ID: path, type, name, start row AND the unit's own content
		// (I-14). Without the content two revisions of one function at one start
		// line collide on a single row, and the branch that indexes last decides
		// the body every branch sees.
		const id = codeUnitRowId(
			filePath,
			unitType,
			name,
			node.startPosition.row,
			content,
		);

		return {
			id,
			parentId,
			unitType,
			filePath,
			startLine: node.startPosition.row + 1, // 1-indexed
			endLine: node.endPosition.row + 1,
			language,
			content,
			name,
			signature,
			fileHash,
			depth,
			metadata,
		};
	}

	/**
	 * Extract name from AST node
	 */
	private extractName(
		node: Node,
		language: SupportedLanguage,
	): string | undefined {
		// Go-specific: type_spec has type_identifier as direct child
		if (node.type === "type_spec") {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "type_identifier") {
					return child.text;
				}
			}
		}

		// Go-specific: method_declaration has field_identifier for method name
		if (node.type === "method_declaration") {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "field_identifier") {
					return child.text;
				}
			}
		}

		// Try common name field patterns
		const namePatterns = ["name", "declarator"];

		for (const pattern of namePatterns) {
			const nameNode = node.childForFieldName(pattern);
			if (nameNode) {
				// Handle nested declarators (C/C++)
				if (nameNode.type === "function_declarator") {
					const innerDecl = nameNode.childForFieldName("declarator");
					if (innerDecl && innerDecl.type === "identifier") {
						return innerDecl.text;
					}
				}
				// Handle type_spec (Go)
				if (nameNode.type === "type_spec") {
					const typeName = nameNode.childForFieldName("name");
					if (typeName) {
						return typeName.text;
					}
				}
				// Direct identifier
				if (
					nameNode.type === "identifier" ||
					nameNode.type === "type_identifier" ||
					nameNode.type === "property_identifier" ||
					nameNode.type === "field_identifier"
				) {
					return nameNode.text;
				}
			}
		}

		// For arrow functions assigned to variables
		if (node.type === "arrow_function") {
			const parent = node.parent;
			if (parent?.type === "variable_declarator") {
				const varName = parent.childForFieldName("name");
				if (varName?.type === "identifier") {
					return varName.text;
				}
			}
		}

		// For impl blocks in Rust
		if (node.type === "impl_item") {
			const typeNode = node.childForFieldName("type");
			if (typeNode?.type === "type_identifier") {
				return `impl ${typeNode.text}`;
			}
		}

		return undefined;
	}

	/**
	 * Extract function/class signature
	 */
	private extractSignature(node: Node, source: string): string | undefined {
		const startLine = node.startPosition.row;
		const lines = source.split("\n");
		let sig = lines[startLine];

		if (!sig) return undefined;

		sig = sig.trim();

		// For multi-line signatures, get until opening brace or closing paren
		if (!sig.includes("{") && !sig.endsWith(")") && !sig.endsWith(":")) {
			for (
				let i = startLine + 1;
				i < Math.min(startLine + 5, lines.length);
				i++
			) {
				const nextLine = lines[i].trim();
				sig += ` ${nextLine}`;
				if (sig.includes("{") || sig.endsWith(")") || sig.endsWith(":")) {
					break;
				}
			}
		}

		// Remove body, keep just signature
		const braceIndex = sig.indexOf("{");
		if (braceIndex > 0) {
			sig = sig.slice(0, braceIndex).trim();
		}

		// Remove trailing colon for Python
		if (sig.endsWith(":")) {
			sig = sig.slice(0, -1).trim();
		}

		// Limit length
		if (sig.length > 300) {
			sig = `${sig.slice(0, 297)}...`;
		}

		return sig || undefined;
	}

	/**
	 * Get units sorted by depth (deepest first) for bottom-up processing
	 */
	sortByDepthDesc(units: CodeUnit[]): CodeUnit[] {
		return [...units].sort((a, b) => b.depth - a.depth);
	}

	/**
	 * Get units sorted by depth (shallowest first) for top-down processing
	 */
	sortByDepthAsc(units: CodeUnit[]): CodeUnit[] {
		return [...units].sort((a, b) => a.depth - b.depth);
	}

	/**
	 * Get children of a unit.
	 *
	 * `parentKey` is `codeUnitParentKeyOf(parent)`, NOT `parent.id` — the two are
	 * different namespaces since I-14, and passing an id here matches nothing.
	 */
	getChildren(units: CodeUnit[], parentKey: string): CodeUnit[] {
		return units.filter((u) => u.parentId === parentKey);
	}

	/**
	 * Get parent of a unit. The stored link is the parent's POSITION KEY, so the
	 * search is over `codeUnitParentKeyOf`, never over `u.id` (I-14).
	 */
	getParent(units: CodeUnit[], childId: string): CodeUnit | undefined {
		const child = units.find((u) => u.id === childId);
		if (!child?.parentId) return undefined;
		return units.find((u) => codeUnitParentKeyOf(u) === child.parentId);
	}

	/**
	 * Build a map of units by ID for fast lookup
	 */
	buildUnitMap(units: CodeUnit[]): Map<string, CodeUnit> {
		return new Map(units.map((u) => [u.id, u]));
	}

	/**
	 * Get units at a specific depth level
	 */
	getUnitsAtDepth(units: CodeUnit[], depth: number): CodeUnit[] {
		return units.filter((u) => u.depth === depth);
	}

	/**
	 * Get the maximum depth in the unit hierarchy
	 */
	getMaxDepth(units: CodeUnit[]): number {
		return Math.max(...units.map((u) => u.depth), 0);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a code unit extractor instance
 */
export function createCodeUnitExtractor(): CodeUnitExtractor {
	return new CodeUnitExtractor();
}
