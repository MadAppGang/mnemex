/**
 * Enrichment Module Exports
 *
 * Public API for the enrichment system.
 */

// Core components
export { Enricher, createEnricher } from "./enricher.js";
export type {
	EnricherOptions,
	FileToEnrich,
	RefinementOptions,
	RefinementResult,
} from "./enricher.js";

export { EnrichmentPipeline, createEnrichmentPipeline } from "./pipeline.js";
export type { PipelineOptions, PipelineResult } from "./pipeline.js";

export { DependencyGraph, createDependencyGraph } from "./dependency-graph.js";

// Extractor infrastructure
export {
	BaseExtractor,
	ExtractorRegistry,
	createExtractorRegistry,
} from "./extractors/base.js";
