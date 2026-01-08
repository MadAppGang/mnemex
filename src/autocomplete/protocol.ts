/**
 * Autocomplete protocol (JSONL-RPC)
 *
 * One JSON object per line over stdin/stdout.
 */

export type AutocompleteMethod =
	| "initialize"
	| "complete"
	| "cancel"
	| "shutdown";

export interface AutocompletePosition {
	/** 0-based line */
	line: number;
	/** 0-based character (UTF-16 code units, VSCode-style) */
	character: number;
}

export interface AutocompleteInitializeParams {
	projectPath: string;
}

export interface AutocompleteCancelParams {
	/** ID of the in-flight request to cancel */
	id: string;
}

export interface AutocompleteCompleteParams {
	projectPath: string;
	filePath: string;
	/** Full document text (optional; expensive to send) */
	text?: string;
	/** Cursor position in the provided `text` */
	position?: AutocompletePosition;
	/** Prefix (text before cursor). If provided, server can avoid needing full `text`. */
	prefix?: string;
	/** Suffix (text after cursor). */
	suffix?: string;
	languageId?: string;
	options?: {
		maxPrefixChars?: number;
		maxSuffixChars?: number;
		maxContextResults?: number;
		repoMapTokens?: number;
		maxTokens?: number;
		temperature?: number;
	};
}

export interface AutocompleteCompleteResult {
	completion: string;
	provider: string;
	model: string;
	latencyMs: number;
	context: {
		retrievedDocuments: number;
		includesRepoMap: boolean;
	};
}

export interface AutocompleteRequest {
	id: string;
	method: AutocompleteMethod;
	params?: unknown;
}

export interface AutocompleteSuccessResponse {
	id: string;
	result: unknown;
}

export interface AutocompleteErrorResponse {
	id: string;
	error: { message: string };
}

export type AutocompleteResponse =
	| AutocompleteSuccessResponse
	| AutocompleteErrorResponse;
