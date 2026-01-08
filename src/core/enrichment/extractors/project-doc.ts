/**
 * Project Documentation Extractor
 *
 * Generates project-level documentation from aggregated file information.
 * Extracts: architecture, getting started, API, contributing, standards docs.
 */

import type {
	BaseDocument,
	ExtractionContext,
	ILLMClient,
	ProjectDoc,
} from "../../../types.js";
import {
	buildProjectDocPrompt,
	getSystemPrompt,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

type DocCategory =
	| "architecture"
	| "getting_started"
	| "api"
	| "contributing"
	| "standards";

interface ProjectDocLLMResponse {
	title: string;
	category: DocCategory;
	sections: Array<{
		heading: string;
		content: string;
	}>;
}

// ============================================================================
// Project Doc Extractor
// ============================================================================

export class ProjectDocExtractor extends BaseExtractor {
	constructor() {
		super("project_doc", ["file_summary", "idiom"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		// Project docs are generated at the project level, not per-file
		// Only generate if we have file summaries and optionally idioms
		if (!context.existingDocs || context.existingDocs.length === 0) {
			return [];
		}

		// Get file summaries
		const fileSummaries = context.existingDocs
			.filter((doc) => doc.documentType === "file_summary")
			.map((doc) => ({
				filePath: doc.filePath || "",
				summary: (doc as any).summary || doc.content,
			}));

		if (fileSummaries.length < 3) {
			// Need at least 3 files to generate meaningful project docs
			return [];
		}

		// Get idioms
		const idioms = context.existingDocs
			.filter((doc) => doc.documentType === "idiom")
			.map((doc) => ({
				pattern: (doc as any).pattern || "",
				rationale: (doc as any).rationale || "",
			}));

		const documents: ProjectDoc[] = [];

		// Generate architecture doc
		try {
			const archDoc = await this.generateDoc(
				"architecture",
				fileSummaries,
				idioms,
				context,
				llmClient,
			);
			if (archDoc) {
				documents.push(archDoc);
			}
		} catch (error) {
			console.warn(
				"Failed to generate architecture doc:",
				error instanceof Error ? error.message : error,
			);
		}

		// Generate standards doc if we have idioms
		if (idioms.length > 0) {
			try {
				const standardsDoc = await this.generateDoc(
					"standards",
					fileSummaries,
					idioms,
					context,
					llmClient,
				);
				if (standardsDoc) {
					documents.push(standardsDoc);
				}
			} catch (error) {
				console.warn(
					"Failed to generate standards doc:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		return documents;
	}

	private async generateDoc(
		category: DocCategory,
		fileSummaries: Array<{ filePath: string; summary: string }>,
		idioms: Array<{ pattern: string; rationale: string }>,
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<ProjectDoc | null> {
		// Build prompt
		const userPrompt = buildProjectDocPrompt(category, fileSummaries, idioms);

		// Call LLM
		const response = await llmClient.completeJSON<ProjectDocLLMResponse>(
			[{ role: "user", content: userPrompt }],
			{ systemPrompt: getSystemPrompt("project_doc") },
		);

		if (!response.sections || response.sections.length === 0) {
			return null;
		}

		// Build searchable content
		const content = this.buildContent(response);
		const id = this.generateId(content, "project", category);

		return {
			id,
			content,
			documentType: "project_doc",
			// Project docs don't have a specific file path
			filePath: undefined,
			createdAt: new Date().toISOString(),
			enrichedAt: new Date().toISOString(),
			sourceIds: context.existingDocs?.map((d) => d.id) || [],
			title: response.title,
			category: response.category || category,
			sections: response.sections,
		};
	}

	/**
	 * Build searchable content from the doc
	 */
	private buildContent(response: ProjectDocLLMResponse): string {
		const parts = [`# ${response.title}`, `Category: ${response.category}`];

		for (const section of response.sections) {
			parts.push(`\n## ${section.heading}`);
			parts.push(section.content);
		}

		return parts.join("\n");
	}

	/**
	 * Override needsUpdate - project docs are only generated once
	 */
	override needsUpdate(context: ExtractionContext): boolean {
		if (!context.existingDocs) {
			return true;
		}

		// Check if project docs already exist
		const existingProjectDocs = context.existingDocs.filter(
			(doc) => doc.documentType === "project_doc",
		);

		return existingProjectDocs.length === 0;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createProjectDocExtractor(): ProjectDocExtractor {
	return new ProjectDocExtractor();
}
