// Message types for communication between the extension host and webview.
// This file is mirrored in webview-ui/src/types/messages.ts.

export interface SearchResult {
  file: string;
  line: number;
  score: number;
  type: string;
  name: string;
  summary?: string;
}

export interface RepoMapEntry {
  filePath: string;
  symbols: Array<{ name: string; kind: string; line: number; rank: number }>;
}

export interface SymbolInfo {
  name: string;
  file: string;
  line: number;
  endLine: number;
  kind: string;
  exported: boolean;
  pagerank: number;
  signature?: string;
}

export interface CallersResult {
  symbol: string;
  callers: Array<{ name: string; file: string; line: number; kind: string }>;
}

export interface CalleesResult {
  symbol: string;
  callees: Array<{ name: string; file: string; line: number; kind: string }>;
}

export interface ContextResult {
  symbol: string;
  file: string;
  line: number;
  kind: string;
  callers: Array<{ name: string; file: string; line: number; kind?: string }>;
  callees: Array<{ name: string; file: string; line: number; kind?: string }>;
}

export interface DeadCodeResult {
  name: string;
  file: string;
  line: number;
  kind: string;
  pagerank: number;
}

export interface TestGapResult {
  name: string;
  file: string;
  line: number;
  kind: string;
  pagerank: number;
  callers: number;
}

export interface ImpactResult {
  symbol: string;
  affected: Array<{ name: string; file: string; line: number; kind: string }>;
}

export interface IndexStatus {
  exists: boolean;
  files?: number;
  chunks?: number;
  languages?: string[];
  model?: string;
  lastUpdated?: string;
}

// Messages from the webview to the extension host
export type WebviewToHostMessage =
  // Lifecycle
  | { type: 'ready' }

  // Search
  | { type: 'search'; query: string; requestId: string }

  // Symbol navigation
  | { type: 'getMap'; requestId: string }
  | { type: 'getSymbol'; name: string; requestId: string }
  | { type: 'getCallers'; name: string; requestId: string }
  | { type: 'getCallees'; name: string; requestId: string }
  | { type: 'getContext'; name: string; requestId: string }

  // Analysis
  | { type: 'getDeadCode'; requestId: string }
  | { type: 'getTestGaps'; requestId: string }
  | { type: 'getImpact'; name: string; requestId: string }

  // Navigation
  | { type: 'openFile'; filePath: string; line: number }

  // Index management
  | { type: 'getStatus'; requestId: string }
  | { type: 'reindex'; requestId: string }

  // Cancellation
  | { type: 'cancel'; requestId: string }

  // Companion panel
  | { type: 'companionReady' }
  | { type: 'companionOpenFile'; filePath: string; line: number }
  | { type: 'companionTogglePin' };

// Messages from the extension host to the webview
export type HostToWebviewMessage =
  // Lifecycle
  | { type: 'init'; projectPath: string; indexExists: boolean }

  // Loading state (for any requestId)
  | { type: 'loading'; requestId: string }

  // Search results
  | { type: 'searchResults'; requestId: string; results: SearchResult[]; query: string }

  // Symbol navigation results
  | { type: 'mapResult'; requestId: string; entries: RepoMapEntry[] }
  | { type: 'symbolResult'; requestId: string; symbol: SymbolInfo }
  | { type: 'callersResult'; requestId: string; data: CallersResult }
  | { type: 'calleesResult'; requestId: string; data: CalleesResult }
  | { type: 'contextResult'; requestId: string; data: ContextResult }

  // Analysis results
  | { type: 'deadCodeResult'; requestId: string; items: DeadCodeResult[] }
  | { type: 'testGapsResult'; requestId: string; items: TestGapResult[] }
  | { type: 'impactResult'; requestId: string; data: ImpactResult }

  // Index management
  | { type: 'statusResult'; requestId: string; status: IndexStatus }
  | { type: 'reindexLine'; requestId: string; line: string }
  | { type: 'reindexComplete'; requestId: string }

  // Errors
  | { type: 'error'; requestId: string; message: string }

  // Companion panel
  | {
      type: 'companionUpdate';
      symbolName: string;
      symbol: SymbolInfo | null;
      callers: CallersResult | null;
      callees: CalleesResult | null;
      summary: string | null;
      sourceCode: string | null;
      language: string | null;
      symbolCount: number;
    }
  | { type: 'companionLoading'; symbolName: string }
  | { type: 'companionEmpty' };
