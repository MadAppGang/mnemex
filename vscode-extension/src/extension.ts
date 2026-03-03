import * as vscode from 'vscode';
import { SearchProvider } from './SearchProvider.js';
import { CompanionPanelProvider } from './CompanionPanelProvider.js';
import { findClaudemem } from './CliBridge.js';
import { log, getOutputChannel } from './log.js';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext): void {
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  log('claudemem extension activating');

  // Auto-detect binary on activation and warn if not found
  const binaryPath = findClaudemem();
  log(`Binary resolved: ${binaryPath}`);
  if (binaryPath === 'claudemem' || !fs.existsSync(binaryPath)) {
    // Only warn if it's the bare name fallback (auto-detect found nothing)
    // We do a quick non-blocking check via which; if it fails, show a notification
    const cfg = vscode.workspace.getConfiguration('claudemem');
    const configured = cfg.get<string>('binaryPath', '');
    if (!configured || configured.trim() === '') {
      // Show notification with install instructions
      void vscode.window
        .showWarningMessage(
          'claudemem binary not found. Install with: npm install -g claude-codemem',
          'Open Settings',
        )
        .then((selection) => {
          if (selection === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'claudemem.binaryPath',
            );
          }
        });
    }
  }

  log('Creating providers');
  const provider = new SearchProvider(context.extensionUri, context);
  const companion = new CompanionPanelProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('claudemem.reindex', () => {
      void provider.reindex();
    }),
    vscode.commands.registerCommand('claudemem.openSearch', () => {
      void vscode.commands.executeCommand('claudememSearch.focus');
    }),
    vscode.commands.registerCommand('claudemem.openCompanion', () => {
      companion.open();
    }),
  );
}

export function deactivate(): void {}
