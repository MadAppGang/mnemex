import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _channel: vscode.OutputChannel | undefined;
let _logFile: string | undefined;

function getLogFile(): string {
  if (!_logFile) {
    const home = process.env['HOME'] ?? '/tmp';
    const dir = path.join(home, '.claudemem');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    _logFile = path.join(dir, 'vscode-extension.log');
    // Truncate on activation to avoid unbounded growth
    try { fs.writeFileSync(_logFile, ''); } catch {}
  }
  return _logFile;
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('claudemem');
  }
  return _channel;
}

export function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${message}\n`;
  getOutputChannel().appendLine(line.trimEnd());
  try { fs.appendFileSync(getLogFile(), line); } catch {}
}

/** Path to the on-disk log file (for external tooling). */
export const LOG_FILE_PATH = path.join(process.env['HOME'] ?? '/tmp', '.claudemem', 'vscode-extension.log');
