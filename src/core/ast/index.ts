/**
 * AST Module
 *
 * Provides AST-based code analysis utilities:
 * - Metadata extraction (visibility, async, parameters, types, references)
 * - Code unit extraction (hierarchical extraction with parent-child relationships)
 */

export {
	ASTMetadataExtractor,
	createASTMetadataExtractor,
	type ExtractionContext,
} from "./metadata-extractor.js";
export {
	CodeUnitExtractor,
	createCodeUnitExtractor,
	type ExtractionOptions,
} from "./code-unit-extractor.js";
