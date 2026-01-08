import { performance } from "node:perf_hooks";
import { basename } from "node:path";
import {
	ensureProjectDir,
	getIndexDbPath,
	getVectorStorePath,
} from "../config.js";
import { createEmbeddingsClient } from "../core/embeddings.js";
import { createVectorStore, type VectorStore } from "../core/store.js";
import { createFileTracker, type FileTracker } from "../core/tracker.js";
import {
	createEnrichedRetriever,
	type EnrichedRetriever,
} from "../retrieval/index.js";
import { createLLMClient, type ILLMClient } from "../llm/client.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type { SupportedLanguage } from "../types.js";
import {
	buildAutocompletePrompt,
	inferStyleHints,
	stripCodeFences,
	trimPrefixOverlap,
	truncateAtSuffixHint,
} from "./prompt.js";
import { loadProjectFacts } from "./project-context.js";
import type {
	AutocompleteCompleteParams,
	AutocompleteCompleteResult,
} from "./protocol.js";

function offsetAt(text: string, line: number, character: number): number {
	if (line <= 0) return Math.min(character, text.length);
	let idx = 0;
	let currentLine = 0;
	while (idx < text.length && currentLine < line) {
		const nl = text.indexOf("\n", idx);
		if (nl === -1) {
			idx = text.length;
			break;
		}
		idx = nl + 1;
		currentLine++;
	}
	return Math.min(idx + character, text.length);
}

function windowAround(
	text: string,
	offset: number,
	maxPrefixChars: number,
	maxSuffixChars: number,
) {
	const start = Math.max(0, offset - maxPrefixChars);
	const end = Math.min(text.length, offset + maxSuffixChars);
	return {
		prefix: text.slice(start, offset),
		suffix: text.slice(offset, end),
	};
}

function buildFimQuery(filePath: string, prefix: string): string {
	const identifiers = (prefix.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])
		.slice(-20)
		.filter((v, i, arr) => arr.indexOf(v) === i);

	const lastLine = prefix.split(/\r?\n/).slice(-1)[0]?.trim() || "";
	const fileName = basename(filePath);

	const parts = [
		"code completion",
		fileName,
		lastLine ? `line: ${lastLine}` : undefined,
		identifiers.length
			? `symbols: ${identifiers.slice(-10).join(" ")}`
			: undefined,
	].filter(Boolean);

	return parts.join(" | ");
}

function extractAstContext(args: {
	filePath: string;
	text: string;
	offset: number;
}): Promise<string | undefined> {
	return (async () => {
		const parserManager = getParserManager();
		const language = parserManager.getLanguage(args.filePath);
		if (!language) return undefined;

		const tree = await parserManager.parse(args.text, language);
		if (!tree) return undefined;

		const node = tree.rootNode.descendantForIndex(args.offset);
		if (!node) return undefined;

		const interestingTypes = new Set([
			"function_declaration",
			"function_definition",
			"method_definition",
			"method_declaration",
			"arrow_function",
			"class_declaration",
			"class_definition",
			"interface_declaration",
			"type_alias_declaration",
			"impl_item",
			"struct_item",
			"enum_item",
			"trait_item",
		]);

		let cur = node;
		while (cur && cur.parent) {
			if (interestingTypes.has(cur.type)) break;
			cur = cur.parent;
		}

		const start = cur.startIndex;
		const end = cur.endIndex;
		const snippet = args.text.slice(start, Math.min(end, start + 1200));
		return `node_type: ${cur.type}\nstart_index: ${start}\nend_index: ${end}\nsnippet:\n${snippet}`;
	})();
}

export class AutocompleteEngine {
	private projectPath: string;
	private llm: ILLMClient | null = null;
	private store: VectorStore | null = null;
	private tracker: FileTracker | null = null;
	private retriever: EnrichedRetriever | null = null;
	private projectFacts: { text: string; mtimeMs?: number } = { text: "" };

	constructor(projectPath: string) {
		this.projectPath = projectPath;
	}

	async initialize(): Promise<void> {
		if (this.store && this.tracker) return;

		ensureProjectDir(this.projectPath);

		const parserManager = getParserManager();
		await parserManager.initialize();

		const storePath = getVectorStorePath(this.projectPath);
		this.store = createVectorStore(storePath);
		await this.store.initialize();

		const indexDbPath = getIndexDbPath(this.projectPath);
		this.tracker = createFileTracker(indexDbPath, this.projectPath);

		try {
			const indexedEmbeddingModel = this.tracker.getMetadata("embeddingModel");
			const embeddings = createEmbeddingsClient({
				model: indexedEmbeddingModel || undefined,
			});
			this.retriever = createEnrichedRetriever(
				this.store,
				embeddings,
				"fim",
				this.tracker,
			);
		} catch {
			// Retrieval is optional for autocomplete; fall back to pure FIM prompting.
			this.retriever = null;
		}

		const facts = loadProjectFacts(this.projectPath);
		this.projectFacts = { text: facts.text, mtimeMs: facts.sourceMtimeMs };
	}

	async close(): Promise<void> {
		if (this.store) await this.store.close();
		if (this.tracker) this.tracker.close();
	}

	private refreshProjectFactsIfNeeded(): void {
		const facts = loadProjectFacts(this.projectPath);
		if (
			facts.sourceMtimeMs &&
			facts.sourceMtimeMs !== this.projectFacts.mtimeMs
		) {
			this.projectFacts = { text: facts.text, mtimeMs: facts.sourceMtimeMs };
		}
	}

	async complete(
		params: AutocompleteCompleteParams & { abortSignal?: AbortSignal },
	): Promise<AutocompleteCompleteResult> {
		await this.initialize();
		this.refreshProjectFactsIfNeeded();

		const start = performance.now();

		if (!this.llm) {
			this.llm = await createLLMClient({}, this.projectPath);
		}

		const maxPrefixChars = params.options?.maxPrefixChars ?? 4000;
		const maxSuffixChars = params.options?.maxSuffixChars ?? 2000;
		const maxContextResults = params.options?.maxContextResults ?? 10;
		const repoMapTokens = params.options?.repoMapTokens ?? 500;

		let prefix = params.prefix ?? "";
		let suffix = params.suffix ?? "";
		let styleText = params.text ?? "";
		let astText = params.text ?? "";
		let astOffset = 0;

		if (params.text && params.position) {
			astText = params.text;
			astOffset = offsetAt(
				params.text,
				params.position.line,
				params.position.character,
			);
			const w = windowAround(
				params.text,
				astOffset,
				maxPrefixChars,
				maxSuffixChars,
			);
			prefix = w.prefix;
			suffix = w.suffix;
			styleText = params.text;
		} else if (params.prefix !== undefined && params.suffix !== undefined) {
			prefix = params.prefix;
			suffix = params.suffix;
			styleText = `${params.prefix}\n${params.suffix}`;
			astText = params.prefix;
			astOffset = params.prefix.length;
		} else {
			throw new Error(
				"Invalid complete params: provide either {text, position} or {prefix, suffix}",
			);
		}

		const parserLanguage = getParserManager().getLanguage(params.filePath);
		const language: SupportedLanguage | "unknown" = parserLanguage || "unknown";

		const fimQuery = buildFimQuery(params.filePath, prefix);

		let retrievedResults: Awaited<
			ReturnType<EnrichedRetriever["searchWithContext"]>
		> | null = null;
		if (this.retriever) {
			try {
				retrievedResults = await this.retriever.searchWithContext(fimQuery, {
					limit: maxContextResults,
					useCase: "fim",
					language: language === "unknown" ? undefined : language,
					includeRepoMap: true,
					repoMapTokens,
				});
			} catch {
				retrievedResults = null;
			}
		}

		const astContext = await extractAstContext({
			filePath: params.filePath,
			text: astText,
			offset: astOffset,
		});
		const styleHints = inferStyleHints(styleText);

		const prompt = buildAutocompletePrompt({
			filePath: params.filePath,
			language:
				language === "unknown" ? params.languageId || "unknown" : language,
			projectFacts: this.projectFacts.text,
			styleHints,
			astContext,
			retrieval: retrievedResults
				? {
						repoMapContext: retrievedResults.repoMapContext,
						results: retrievedResults.results,
					}
				: undefined,
			prefix,
			suffix,
		});

		const response = await this.llm.complete(
			[{ role: "user", content: prompt.userPrompt }],
			{
				systemPrompt: prompt.systemPrompt,
				maxTokens: params.options?.maxTokens ?? 200,
				temperature: params.options?.temperature ?? 0.2,
				abortSignal: params.abortSignal,
			},
		);

		let completion = stripCodeFences(response.content);
		completion = trimPrefixOverlap(prefix, completion);
		completion = truncateAtSuffixHint(suffix, completion);
		completion = completion.replace(/\r\n/g, "\n");

		const latencyMs = Math.round(performance.now() - start);

		return {
			completion,
			provider: this.llm.getProvider(),
			model: response.model || this.llm.getModel(),
			latencyMs,
			context: {
				retrievedDocuments: retrievedResults?.results?.length || 0,
				includesRepoMap: !!retrievedResults?.repoMapContext,
			},
		};
	}
}
