import * as vscode from 'vscode';

/**
 * Resolves the cursor position to a symbol name using VS Code's
 * DocumentSymbolProvider. Returns null if no symbol is found at the cursor.
 */
export class CursorTracker {
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastSymbolName = '';
  private _pinned = false;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _onSymbolChange: (symbolName: string | null) => void) {}

  /**
   * Start tracking cursor movements. Calls onSymbolChange when the symbol
   * under the cursor changes (debounced 500ms, deduplicated).
   */
  start(): void {
    this._disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this._pinned) {
          return;
        }
        this._scheduleResolve(e.textEditor);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this._pinned || !editor) {
          return;
        }
        this._scheduleResolve(editor);
      }),
    );
  }

  togglePin(): boolean {
    this._pinned = !this._pinned;
    return this._pinned;
  }

  get pinned(): boolean {
    return this._pinned;
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }

  private _scheduleResolve(editor: vscode.TextEditor): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      void this._resolveSymbol(editor);
    }, 500);
  }

  private async _resolveSymbol(editor: vscode.TextEditor): Promise<void> {
    const position = editor.selection.active;
    const uri = editor.document.uri;

    // Only process file:// URIs (skip output panels, git diffs, etc.)
    if (uri.scheme !== 'file') {
      return;
    }

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );

      if (!symbols || symbols.length === 0) {
        if (this._lastSymbolName !== '') {
          this._lastSymbolName = '';
          this._onSymbolChange(null);
        }
        return;
      }

      const symbolName = this._findSymbolAtPosition(symbols, position);

      if (symbolName !== this._lastSymbolName) {
        this._lastSymbolName = symbolName;
        this._onSymbolChange(symbolName || null);
      }
    } catch {
      // DocumentSymbolProvider not available for this language — silently ignore
    }
  }

  /**
   * Walk the DocumentSymbol tree to find the innermost symbol containing the position.
   * Returns the symbol name, or empty string if the cursor is not inside any symbol.
   */
  private _findSymbolAtPosition(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
  ): string {
    for (const symbol of symbols) {
      if (symbol.range.contains(position)) {
        // Check children first for a more specific match
        const childName = this._findSymbolAtPosition(symbol.children, position);
        if (childName) {
          return childName;
        }
        // Only return function/class/method/interface-level symbols, not variables
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
}
