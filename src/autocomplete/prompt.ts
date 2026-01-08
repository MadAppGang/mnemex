import type { BaseDocument, EnrichedSearchResult } from "../types.js";

export interface StyleHints {
	indent?: string;
	semicolons?: boolean;
	quotes?: "single" | "double";
}

export function inferStyleHints(text: string): StyleHints {
	const lines = text.split(/\r?\n/).slice(0, 400);

	let tabIndented = 0;
	let twoSpaces = 0;
	let fourSpaces = 0;
	let semicolons = 0;
	let statementLines = 0;
	let singleQuotes = 0;
	let doubleQuotes = 0;

	for (const line of lines) {
		if (line.startsWith("\t")) tabIndented++;
		if (line.startsWith("  ") && !line.startsWith("   ")) twoSpaces++;
		if (line.startsWith("    ") && !line.startsWith("     ")) fourSpaces++;

		const trimmed = line.trim();
		if (!trimmed) continue;

		if (!trimmed.startsWith("//") && !trimmed.startsWith("#")) {
			statementLines++;
			if (trimmed.endsWith(";")) semicolons++;
		}

		singleQuotes += (trimmed.match(/'/g) || []).length;
		doubleQuotes += (trimmed.match(/"/g) || []).length;
	}

	let indent: string | undefined;
	if (tabIndented > twoSpaces && tabIndented > fourSpaces) indent = "\t";
	else if (fourSpaces > twoSpaces) indent = "    ";
	else if (twoSpaces > 0) indent = "  ";

	const quotes: StyleHints["quotes"] =
		singleQuotes > doubleQuotes
			? "single"
			: doubleQuotes > singleQuotes
				? "double"
				: undefined;

	return {
		indent,
		semicolons:
			statementLines > 20 ? semicolons / statementLines > 0.6 : undefined,
		quotes,
	};
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…[truncated]`;
}

function formatDoc(doc: BaseDocument, maxChars: number): string {
	const header = [
		`type: ${doc.documentType}`,
		doc.filePath ? `file: ${doc.filePath}` : undefined,
		doc.metadata?.startLine ? `line: ${doc.metadata.startLine}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	switch (doc.documentType) {
		case "code_chunk":
			return `${header}\ncontent:\n${clip(doc.content, maxChars)}`;
		case "file_summary":
		case "symbol_summary":
		case "idiom":
		case "usage_example":
		case "anti_pattern":
		case "project_doc":
			return `${header}\ncontent:\n${clip(doc.content, maxChars)}`;
		default:
			return `${header}\ncontent:\n${clip(doc.content, maxChars)}`;
	}
}

export function buildAutocompletePrompt(args: {
	filePath: string;
	language: string;
	projectFacts?: string;
	styleHints?: StyleHints;
	astContext?: string;
	retrieval?: {
		repoMapContext?: string;
		results: EnrichedSearchResult[];
	};
	prefix: string;
	suffix: string;
}): { systemPrompt: string; userPrompt: string } {
	const systemPrompt = [
		"You are a code autocomplete engine.",
		"Return ONLY the text to insert at the cursor.",
		"Do not wrap in markdown or code fences.",
		"Do not repeat the prefix or the suffix.",
		"Match the project's style and conventions.",
		"If you are not confident, return an empty string.",
	].join("\n");

	const userParts: string[] = [];
	userParts.push(`file: ${args.filePath}`);
	userParts.push(`language: ${args.language}`);

	if (args.projectFacts) {
		userParts.push("\n[project]\n" + args.projectFacts.trim());
	}

	if (args.styleHints && Object.keys(args.styleHints).length > 0) {
		userParts.push("\n[style_hints]\n" + JSON.stringify(args.styleHints));
	}

	if (args.astContext) {
		userParts.push("\n[ast_context]\n" + args.astContext.trim());
	}

	if (args.retrieval?.repoMapContext) {
		userParts.push("\n[repo_map]\n" + args.retrieval.repoMapContext.trim());
	}

	if (args.retrieval?.results?.length) {
		const docs = args.retrieval.results
			.slice(0, 12)
			.map(
				(r, i) =>
					`\n[context_${i + 1}] score=${r.score.toFixed(3)}\n${formatDoc(r.document, 1400)}`,
			)
			.join("\n");
		userParts.push("\n[retrieved_context]" + docs);
	}

	userParts.push(
		[
			"\n[fim]",
			"--- prefix ---",
			args.prefix,
			"--- suffix ---",
			args.suffix,
			"--- end ---",
		].join("\n"),
	);

	return {
		systemPrompt,
		userPrompt: userParts.join("\n"),
	};
}

export function stripCodeFences(text: string): string {
	let out = text.trim();
	if (out.startsWith("```")) {
		const firstNewline = out.indexOf("\n");
		if (firstNewline !== -1) out = out.slice(firstNewline + 1);
		if (out.endsWith("```")) out = out.slice(0, -3);
	}
	return out.trim();
}

export function trimPrefixOverlap(
	prefix: string,
	completion: string,
	maxOverlap = 80,
): string {
	const max = Math.min(maxOverlap, prefix.length, completion.length);
	for (let k = max; k > 0; k--) {
		if (prefix.endsWith(completion.slice(0, k))) {
			return completion.slice(k);
		}
	}
	return completion;
}

export function truncateAtSuffixHint(
	suffix: string,
	completion: string,
): string {
	const hint = suffix.trim().slice(0, 40);
	if (!hint) return completion;
	const idx = completion.indexOf(hint);
	if (idx === -1) return completion;
	return completion.slice(0, idx);
}
