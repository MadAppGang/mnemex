import * as vscode from 'vscode';
import { getNonce } from './util/nonce.js';
import { CliBridge } from './CliBridge.js';
import { log } from './log.js';
import type {
  WebviewToHostMessage,
  HostToWebviewMessage,
} from './types/messages.js';

/**
 * SearchProvider implements the VS Code WebviewViewProvider for the claudemem
 * sidebar panel. It manages the React webview, routes messages from the webview
 * to the CliBridge, and posts results back.
 *
 * retainContextWhenHidden: true — React state is preserved when panel is hidden.
 */
export class SearchProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudememSearch';

  private _view?: vscode.WebviewView;
  private readonly _bridge: CliBridge;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._bridge = new CliBridge();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-ui'),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => this._handleMessage(message),
      undefined,
      this._context.subscriptions,
    );
  }

  /**
   * Public method called by the claudemem.reindex command.
   */
  async reindex(): Promise<void> {
    const requestId = `reindex-${Date.now()}`;
    const projectPath = this._getProjectPath();
    if (!projectPath) {
      void vscode.window.showErrorMessage('claudemem: No workspace folder open.');
      return;
    }

    this._postMessage({ type: 'loading', requestId });

    try {
      await this._bridge.index(
        projectPath,
        (line) => {
          this._postMessage({ type: 'reindexLine', requestId, line });
        },
        requestId,
      );
      this._postMessage({ type: 'reindexComplete', requestId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'error', requestId, message: msg });
    }
  }

  private async _handleMessage(message: WebviewToHostMessage): Promise<void> {
    const projectPath = this._getProjectPath();
    log(`handleMessage: type=${message.type} projectPath=${projectPath}`);

    if (message.type === 'ready') {
      // Send init state. If the webview missed a previous init, this re-sends it.
      if (!projectPath) {
        // No workspace open
        this._postMessage({ type: 'init', projectPath: '', indexExists: false });
        return;
      }

      try {
        const status = await this._bridge.status(projectPath);
        this._postMessage({
          type: 'init',
          projectPath,
          indexExists: status.exists,
        });
        // Also send the full status for the StatusBar
        const statusRequestId = `init-status-${Date.now()}`;
        this._postMessage({ type: 'statusResult', requestId: statusRequestId, status });
      } catch {
        this._postMessage({ type: 'init', projectPath, indexExists: false });
      }
      return;
    }

    if (!projectPath) {
      if ('requestId' in message && typeof (message as { requestId?: string }).requestId === 'string') {
        this._postMessage({
          type: 'error',
          requestId: (message as { requestId: string }).requestId,
          message: 'No workspace folder open. Open a folder to use claudemem.',
        });
      }
      return;
    }

    if (message.type === 'cancel') {
      this._bridge.cancel(message.requestId);
      return;
    }

    if (message.type === 'openFile') {
      await this._openFile(message.filePath, message.line);
      return;
    }

    // Companion messages are handled by CompanionPanelProvider, not here
    if (message.type === 'companionReady' || message.type === 'companionOpenFile' || message.type === 'companionTogglePin') {
      return;
    }

    const { requestId } = message;
    this._postMessage({ type: 'loading', requestId });

    try {
      switch (message.type) {
        case 'search': {
          const results = await this._bridge.search(message.query, projectPath, requestId);
          this._postMessage({
            type: 'searchResults',
            requestId,
            results,
            query: message.query,
          });
          break;
        }

        case 'getMap': {
          const entries = await this._bridge.map(projectPath, requestId);
          this._postMessage({ type: 'mapResult', requestId, entries });
          break;
        }

        case 'getSymbol': {
          const symbol = await this._bridge.symbol(message.name, projectPath, requestId);
          this._postMessage({ type: 'symbolResult', requestId, symbol });
          break;
        }

        case 'getCallers': {
          const data = await this._bridge.callers(message.name, projectPath, requestId);
          this._postMessage({ type: 'callersResult', requestId, data });
          break;
        }

        case 'getCallees': {
          const data = await this._bridge.callees(message.name, projectPath, requestId);
          this._postMessage({ type: 'calleesResult', requestId, data });
          break;
        }

        case 'getContext': {
          const data = await this._bridge.context(message.name, projectPath, requestId);
          this._postMessage({ type: 'contextResult', requestId, data });
          break;
        }

        case 'getDeadCode': {
          const items = await this._bridge.deadCode(projectPath, requestId);
          this._postMessage({ type: 'deadCodeResult', requestId, items });
          break;
        }

        case 'getTestGaps': {
          const items = await this._bridge.testGaps(projectPath, requestId);
          this._postMessage({ type: 'testGapsResult', requestId, items });
          break;
        }

        case 'getImpact': {
          const data = await this._bridge.impact(message.name, projectPath, requestId);
          this._postMessage({ type: 'impactResult', requestId, data });
          break;
        }

        case 'getStatus': {
          const status = await this._bridge.status(projectPath, requestId);
          this._postMessage({ type: 'statusResult', requestId, status });
          break;
        }

        case 'reindex': {
          await this._bridge.index(
            projectPath,
            (line) => {
              this._postMessage({ type: 'reindexLine', requestId, line });
            },
            requestId,
          );
          this._postMessage({ type: 'reindexComplete', requestId });
          break;
        }

        default: {
          // Unhandled message types are silently ignored for forward compatibility
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'error', requestId, message: msg });
    }
  }

  private _postMessage(message: HostToWebviewMessage): void {
    this._view?.webview.postMessage(message);
  }

  private async _openFile(filePath: string, line: number): Promise<void> {
    log(`openFile: ${filePath}:${line}`);
    try {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      // Convert 1-based line number to 0-based VS Code position
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
  <title>claudemem</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
