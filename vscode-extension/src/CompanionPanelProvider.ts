import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from './util/nonce.js';
import { CliBridge } from './CliBridge.js';
import { CursorTracker } from './CursorTracker.js';
import { log } from './log.js';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
  SymbolInfo,
  ContextResult,
} from './types/messages.js';

/**
 * CompanionPanelProvider manages a WebviewPanel that opens beside the active
 * editor and updates in real-time as the cursor moves between symbols.
 *
 * Data flow:
 *   Cursor moves → CursorTracker resolves symbol name (debounced 500ms)
 *   → If symbol changed, fetch in parallel: symbol, callers, callees, search (summary)
 *   → Read source code from VS Code editor directly
 *   → Compose results → postMessage to webview → React renders
 */
export class CompanionPanelProvider {
  private _panel: vscode.WebviewPanel | undefined;
  private _tracker: CursorTracker | undefined;
  private readonly _bridge: CliBridge;
  private _fetchSeq = 0; // Monotonic sequence to discard stale fetches
  private _cachedSymbolCount = 100; // Cached from init, avoids slow status call

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._bridge = new CliBridge();
  }

  /**
   * Open or reveal the companion panel. Called by the claudemem.openCompanion command.
   */
  open(): void {
    log('Companion: open()');
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'claudememCompanion',
      'claudemem: Symbol Context',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-ui'),
        ],
      },
    );

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => this._handleMessage(message),
      undefined,
      this._context.subscriptions,
    );

    this._panel.onDidDispose(() => {
      this._panel = undefined;
      this._tracker?.dispose();
      this._tracker = undefined;
    });

    // Start cursor tracking
    this._tracker = new CursorTracker((symbolName) => {
      void this._onSymbolChange(symbolName);
    });
    this._tracker.start();

    // Trigger an initial resolve for the current cursor position
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      // Small delay to let webview mount
      setTimeout(() => {
        void this._onSymbolChange(null);
      }, 300);
    }
  }

  private _handleMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'companionReady': {
        // Re-resolve current symbol when webview signals ready
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          void this._resolveAndFetch(editor);
        }
        break;
      }
      case 'companionOpenFile':
        void this._openFile(message.filePath, message.line);
        break;
      case 'companionTogglePin':
        this._tracker?.togglePin();
        break;
      default:
        break;
    }
  }

  private async _resolveAndFetch(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
      return;
    }

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      if (!symbols || symbols.length === 0) {
        this._postMessage({ type: 'companionEmpty' });
        return;
      }

      const position = editor.selection.active;
      const symbolName = this._findSymbolAtPosition(symbols, position);
      if (symbolName) {
        await this._fetchSymbolData(symbolName);
      } else {
        this._postMessage({ type: 'companionEmpty' });
      }
    } catch {
      this._postMessage({ type: 'companionEmpty' });
    }
  }

  private _findSymbolAtPosition(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
  ): string {
    for (const symbol of symbols) {
      if (symbol.range.contains(position)) {
        const childName = this._findSymbolAtPosition(symbol.children, position);
        if (childName) {
          return childName;
        }
        if (this._isTrackableKind(symbol.kind)) {
          return symbol.name;
        }
      }
    }
    return '';
  }

  private _isTrackableKind(kind: vscode.SymbolKind): boolean {
    return (
      kind === vscode.SymbolKind.Function ||
      kind === vscode.SymbolKind.Method ||
      kind === vscode.SymbolKind.Class ||
      kind === vscode.SymbolKind.Interface ||
      kind === vscode.SymbolKind.Enum ||
      kind === vscode.SymbolKind.Constructor ||
      kind === vscode.SymbolKind.Struct
    );
  }

  private async _onSymbolChange(symbolName: string | null): Promise<void> {
    log(`Companion: cursor → ${symbolName ?? '(none)'}`);
    if (!this._panel) {
      return;
    }

    if (!symbolName) {
      this._postMessage({ type: 'companionEmpty' });
      return;
    }

    await this._fetchSymbolData(symbolName);
  }

  /**
   * Cache symbol count from status on first use. Avoids calling status (~10s)
   * on every cursor move.
   */
  async initSymbolCount(projectPath: string): Promise<void> {
    try {
      const status = await this._bridge.status(projectPath);
      if (status.chunks) {
        this._cachedSymbolCount = status.chunks;
      }
    } catch {
      // Use default
    }
  }

  private async _fetchSymbolData(symbolName: string): Promise<void> {
    const projectPath = this._getProjectPath();
    if (!projectPath) {
      return;
    }

    // Increment sequence to discard stale results
    const seq = ++this._fetchSeq;
    log(`Companion: fetching data for "${symbolName}" (seq=${seq})`);

    this._postMessage({ type: 'companionLoading', symbolName });

    // Use 'context' (1 process, ~0.3s) for symbol+callers+callees combined,
    // and 'symbol' (1 process, ~0.3s) for extra fields (pagerank, signature, endLine).
    // This replaces 4 separate CLI calls + status that spawned 5+ concurrent processes.
    const [contextResult, symbolResult] = await Promise.allSettled([
      this._bridge.context(symbolName, projectPath),
      this._bridge.symbol(symbolName, projectPath),
    ]);

    // Discard if a newer fetch has started
    if (seq !== this._fetchSeq) {
      return;
    }

    const ctx: ContextResult | null =
      contextResult.status === 'fulfilled' ? contextResult.value : null;
    const symbol: SymbolInfo | null =
      symbolResult.status === 'fulfilled' ? symbolResult.value : null;

    // Build callers/callees from context result
    const callers = ctx ? { symbol: ctx.symbol, callers: ctx.callers.map(c => ({ ...c, kind: c.kind ?? '' })) } : null;
    const callees = ctx ? { symbol: ctx.symbol, callees: ctx.callees.map(c => ({ ...c, kind: c.kind ?? '' })) } : null;

    // Read source code directly from VS Code (instant, no CLI call)
    // symbol.file is relative (e.g. "src/cli.ts") — resolve against projectPath
    let sourceCode: string | null = null;
    let language: string | null = null;
    if (symbol) {
      try {
        const absolutePath = symbol.file.startsWith('/')
          ? symbol.file
          : path.join(projectPath, symbol.file);
        const uri = vscode.Uri.file(absolutePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        language = doc.languageId;
        const startLine = Math.max(0, symbol.line - 1);
        const endLine = symbol.endLine;
        const lines: string[] = [];
        for (let i = startLine; i < endLine && i < doc.lineCount; i++) {
          lines.push(doc.lineAt(i).text);
        }
        sourceCode = lines.join('\n');
      } catch (err) {
        log(`Companion: failed to read source: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Send main update immediately (fast — ~0.5s total)
    this._postMessage({
      type: 'companionUpdate',
      symbolName,
      symbol,
      callers,
      callees,
      summary: null,
      sourceCode,
      language,
      symbolCount: this._cachedSymbolCount,
    });

    // Lazy-load summary via search (expensive ~5s embedding call)
    // Fires after the main update so UI is responsive immediately
    if (seq === this._fetchSeq) {
      try {
        const searchResults = await this._bridge.search(symbolName, projectPath);
        if (seq === this._fetchSeq) {
          const match = searchResults.find(r => r.name === symbolName && r.summary);
          if (match?.summary) {
            this._postMessage({
              type: 'companionUpdate',
              symbolName,
              symbol,
              callers,
              callees,
              summary: match.summary,
              sourceCode,
              language,
              symbolCount: this._cachedSymbolCount,
            });
          }
        }
      } catch {
        // Summary is optional — ignore failures
      }
    }
  }

  private _postMessage(message: HostToWebviewMessage): void {
    this._panel?.webview.postMessage(message);
  }

  private async _openFile(filePath: string, line: number): Promise<void> {
    try {
      const projectPath = this._getProjectPath();
      const absolutePath = filePath.startsWith('/')
        ? filePath
        : projectPath
          ? path.join(projectPath, filePath)
          : filePath;
      const uri = vscode.Uri.file(absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(position, position),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`claudemem: Cannot open file — ${msg}`);
    }
  }

  private _getProjectPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return folders[0].uri.fsPath;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-ui');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.css'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} data:;
             font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}" />
  <title>claudemem: Symbol Context</title>
</head>
<body>
  <div id="root" data-mode="companion"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
