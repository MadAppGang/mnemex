/**
 * Extractor Exports
 *
 * Public API for document extractors.
 */

// Base classes
export {
	BaseExtractor,
	ExtractorRegistry,
	createExtractorRegistry,
} from "./base.js";

// Extractors
export {
	FileSummaryExtractor,
	createFileSummaryExtractor,
} from "./file-summary.js";
export {
	SymbolSummaryExtractor,
	createSymbolSummaryExtractor,
} from "./symbol-summary.js";
export { IdiomExtractor, createIdiomExtractor } from "./idiom.js";
export {
	UsageExampleExtractor,
	createUsageExampleExtractor,
} from "./usage-example.js";
export {
	AntiPatternExtractor,
	createAntiPatternExtractor,
} from "./anti-pattern.js";
export {
	ProjectDocExtractor,
	createProjectDocExtractor,
} from "./project-doc.js";

// Import for internal use
import { createFileSummaryExtractor } from "./file-summary.js";
import { createSymbolSummaryExtractor } from "./symbol-summary.js";
import { createIdiomExtractor } from "./idiom.js";
import { createUsageExampleExtractor } from "./usage-example.js";
import { createAntiPatternExtractor } from "./anti-pattern.js";
import { createProjectDocExtractor } from "./project-doc.js";

// Factory to create all default extractors
export function createDefaultExtractors() {
	return [
		createFileSummaryExtractor(),
		createSymbolSummaryExtractor(),
		createIdiomExtractor(),
		createUsageExampleExtractor(),
		createAntiPatternExtractor(),
		createProjectDocExtractor(),
	];
}
