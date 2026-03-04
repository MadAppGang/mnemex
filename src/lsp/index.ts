/**
 * LSP Module
 *
 * Public exports for the LSP client layer.
 */

export { LspClient } from "./client.js";
export type { LspState, LspClientConfig } from "./client.js";
export { LspManager } from "./manager.js";
export type { LspManagerConfig } from "./manager.js";
export { LspTransport } from "./transport.js";
export { LANGUAGE_SERVER_CONFIGS } from "./registry.js";
export type { LanguageServerConfig } from "./registry.js";

export {
	pathToUri,
	uriToPath,
	LSP_METHODS,
	type Position,
	type Range,
	type Location,
	type TextEdit,
	type TextDocumentEdit,
	type WorkspaceEdit,
	type Hover,
	type MarkupContent,
	type RenameParams,
	type ReferenceParams,
	type InitializeResult,
	type ServerCapabilities,
} from "./protocol.js";
