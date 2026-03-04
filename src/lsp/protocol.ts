/**
 * LSP Protocol Types
 *
 * Minimal LSP type definitions for the 12 methods we use.
 * Not the full LSP spec — just what claudemem needs.
 */

// ============================================================================
// Base Types
// ============================================================================

export interface Position {
	/** Zero-based line number */
	line: number;
	/** Zero-based character offset (UTF-16 code units) */
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface TextDocumentIdentifier {
	uri: string;
}

export interface TextDocumentPositionParams {
	textDocument: TextDocumentIdentifier;
	position: Position;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number;
}

// ============================================================================
// Text Edits
// ============================================================================

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface TextDocumentEdit {
	textDocument: VersionedTextDocumentIdentifier;
	edits: TextEdit[];
}

/**
 * WorkspaceEdit supports both forms per LSP spec.
 * Servers may return either `changes` or `documentChanges`.
 */
export interface WorkspaceEdit {
	/** URI → TextEdit[] mapping (simple form) */
	changes?: Record<string, TextEdit[]>;
	/** Versioned document edits (rich form) */
	documentChanges?: TextDocumentEdit[];
}

// ============================================================================
// Content Change Events
// ============================================================================

export interface TextDocumentContentChangeEvent {
	/** Full text replacement (we only support full sync) */
	text: string;
}

// ============================================================================
// Initialize
// ============================================================================

export interface InitializeParams {
	processId: number | null;
	rootUri: string | null;
	capabilities: ClientCapabilities;
	initializationOptions?: unknown;
}

export interface ClientCapabilities {
	textDocument?: {
		synchronization?: {
			didSave?: boolean;
		};
		definition?: { dynamicRegistration?: boolean };
		references?: { dynamicRegistration?: boolean };
		hover?: { contentFormat?: string[] };
		rename?: { prepareSupport?: boolean };
	};
	workspace?: {
		workspaceEdit?: {
			documentChanges?: boolean;
		};
	};
}

export interface ServerCapabilities {
	textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean };
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	hoverProvider?: boolean;
	renameProvider?: boolean | { prepareProvider?: boolean };
}

export interface InitializeResult {
	capabilities: ServerCapabilities;
}

// ============================================================================
// Hover
// ============================================================================

export interface Hover {
	contents: MarkupContent | string | Array<string | { language: string; value: string }>;
	range?: Range;
}

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

// ============================================================================
// Rename
// ============================================================================

export interface RenameParams extends TextDocumentPositionParams {
	newName: string;
}

// ============================================================================
// References
// ============================================================================

export interface ReferenceParams extends TextDocumentPositionParams {
	context: {
		includeDeclaration: boolean;
	};
}

// ============================================================================
// LSP Methods
// ============================================================================

/** Methods we use */
export const LSP_METHODS = {
	INITIALIZE: "initialize",
	INITIALIZED: "initialized",
	SHUTDOWN: "shutdown",
	EXIT: "exit",
	DID_OPEN: "textDocument/didOpen",
	DID_CHANGE: "textDocument/didChange",
	DID_SAVE: "textDocument/didSave",
	DID_CLOSE: "textDocument/didClose",
	DEFINITION: "textDocument/definition",
	REFERENCES: "textDocument/references",
	HOVER: "textDocument/hover",
	RENAME: "textDocument/rename",
} as const;

// ============================================================================
// Helpers
// ============================================================================

/** Convert a file path to a file:// URI */
export function pathToUri(filePath: string): string {
	return `file://${filePath}`;
}

/** Convert a file:// URI to a file path */
export function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		return decodeURIComponent(uri.slice(7));
	}
	return uri;
}
