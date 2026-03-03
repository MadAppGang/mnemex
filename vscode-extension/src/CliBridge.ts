import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from './log.js';
import { parseSearchOutput } from './parsers/search.js';
import { parseMapOutput } from './parsers/map.js';
import { parseStatusOutput } from './parsers/status.js';
import { parseSymbolOutput } from './parsers/symbol.js';
import { parseCallersOutput } from './parsers/callers.js';
import { parseCalleesOutput } from './parsers/callees.js';
import { parseContextOutput } from './parsers/context.js';
import { parseDeadCodeOutput, parseTestGapsOutput, parseImpactOutput } from './parsers/analysis.js';
import type {
  SearchResult,
  RepoMapEntry,
  IndexStatus,
  SymbolInfo,
  CallersResult,
  CalleesResult,
  ContextResult,
  DeadCodeResult,
  TestGapResult,
  ImpactResult,
} from './types/messages.js';

export class CliBridgeError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = 'CliBridgeError';
  }
}

/**
 * Find the claudemem binary path.
 *
 * Resolution order:
 * 1. VS Code setting claudemem.binaryPath (if non-empty)
 * 2. `which claudemem` (user's shell PATH via /bin/sh)
 * 3. Common install locations (bun global, npm global, /usr/local/bin)
 */
export function findClaudemem(): string {
  const cfg = vscode.workspace.getConfiguration('claudemem');
  const configured = cfg.get<string>('binaryPath', '');
  if (configured && configured.trim() !== '') {
    return configured.trim();
  }

  // Try which via shell to pick up user PATH
  try {
    const result = execSync('/bin/sh -c "which claudemem"', { encoding: 'utf8', timeout: 3000 });
    const found = result.trim();
    if (found) {
      return found;
    }
  } catch {
    // which failed — continue to fallbacks
  }

  // Common install locations
  const home = process.env['HOME'] ?? '';
  const candidates = [
    path.join(home, '.bun', 'install', 'global', 'bin', 'claudemem'),
    path.join(home, '.npm-global', 'bin', 'claudemem'),
    path.join(home, '.local', 'bin', 'claudemem'),
    '/usr/local/bin/claudemem',
    '/usr/bin/claudemem',
    '/opt/homebrew/bin/claudemem',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to bare name and let spawn fail with a useful ENOENT message
  return 'claudemem';
}

/**
 * Detect whether the claudemem binary needs to run under bun.
 * Bun-compiled scripts contain `bun:` protocol imports (bun:sqlite, bun:ffi)
 * that Node.js cannot resolve. When the binary is bun-installed, we spawn
 * `bun run <script>` instead of running the script directly.
 */
function needsBunRuntime(binaryPath: string): boolean {
  try {
    // Quick heuristic: if it lives under .bun/ it was installed by bun
    if (binaryPath.includes('.bun/') || binaryPath.includes('.bun\\')) {
      return true;
    }
    // Fallback: peek at the file for bun: imports
    const fd = fs.openSync(binaryPath, 'r');
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return buf.toString('utf8').includes('bun:');
  } catch {
    return false;
  }
}

/**
 * Find the bun binary path for spawning bun-based scripts.
 */
function findBun(): string {
  try {
    const result = execSync('/bin/sh -c "which bun"', { encoding: 'utf8', timeout: 3000 });
    const found = result.trim();
    if (found) {
      return found;
    }
  } catch {
    // which failed
  }
  const home = process.env['HOME'] ?? '';
  const candidate = path.join(home, '.bun', 'bin', 'bun');
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return 'bun';
}

/**
 * CliBridge: spawns the claudemem CLI with --agent mode, collects output, and
 * returns typed parsed results. All commands use AbortController for timeout
 * and cancellation. stderr is collected and included in error messages.
 */
export class CliBridge {
  private readonly _binaryPath: string;
  private readonly _useBun: boolean;
  private readonly _bunPath: string;
  private readonly _timeoutMs: number;
  private readonly _activeControllers = new Map<string, AbortController>();

  constructor() {
    this._binaryPath = findClaudemem();
    this._useBun = needsBunRuntime(this._binaryPath);
    this._bunPath = this._useBun ? findBun() : '';
    const cfg = vscode.workspace.getConfiguration('claudemem');
    this._timeoutMs = (cfg.get<number>('commandTimeoutSeconds', 60)) * 1000;
    log(`CliBridge: binary=${this._binaryPath} useBun=${this._useBun}${this._useBun ? ` bunPath=${this._bunPath}` : ''} timeout=${this._timeoutMs}ms`);
  }

  /** Build the spawn command and args, using bun when needed. */
  private _spawnArgs(args: string[]): { command: string; spawnArgs: string[] } {
    if (this._useBun) {
      return { command: this._bunPath, spawnArgs: ['run', this._binaryPath, ...args, '--agent'] };
    }
    return { command: this._binaryPath, spawnArgs: [...args, '--agent'] };
  }

  /**
   * Cancel an in-flight command by requestId.
   */
  cancel(requestId: string): void {
    const controller = this._activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      this._activeControllers.delete(requestId);
    }
  }

  /**
   * Run a claudemem command and collect all stdout. Rejects on non-zero exit,
   * timeout, or spawn error. requestId is used for cancellation tracking.
   */
  async runCommand(
    args: string[],
    projectPath: string,
    requestId?: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);

    if (requestId) {
      this._activeControllers.set(requestId, controller);
    }

    try {
      return await new Promise<string>((resolve, reject) => {
        const { command, spawnArgs } = this._spawnArgs(args);
        log(`exec: ${command} ${spawnArgs.join(' ')}`);
        const child = spawn(command, spawnArgs, {
          cwd: projectPath,
          env: { ...process.env, CI: '1' },
          signal: controller.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const spawnTime = Date.now();
        log(`  pid=${child.pid ?? 'none'}`);
        child.stdout.on('data', (chunk: Buffer) => {
          if (stdoutChunks.length === 0) {
            log(`  first stdout at +${Date.now() - spawnTime}ms (${chunk.length} bytes)`);
          }
          stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          log(`  stderr at +${Date.now() - spawnTime}ms: ${chunk.toString('utf8').trim().slice(0, 200)}`);
          stderrChunks.push(chunk);
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.name === 'AbortError' || controller.signal.aborted) {
            reject(new CliBridgeError('Command timed out or was cancelled', '', null));
          } else if (err.code === 'ENOENT') {
            const hint = this._useBun
              ? `bun not found at "${this._bunPath}". Install bun or set claudemem.binaryPath.`
              : `claudemem binary not found at "${this._binaryPath}". Install claudemem or set claudemem.binaryPath in settings.`;
            reject(
              new CliBridgeError(hint, '', null),
            );
          } else {
            reject(new CliBridgeError(err.message, '', null));
          }
        });

        child.on('close', (code: number | null) => {
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          const stderr = Buffer.concat(stderrChunks).toString('utf8');

          if (stderr.trim()) {
            log(`stderr: ${stderr.trim().slice(0, 500)}`);
          }
          log(`exit code=${code} stdout=${stdout.length} bytes`);

          if (code !== 0) {
            const msg = stderr.trim() || `Command exited with code ${code}`;
            reject(new CliBridgeError(msg, stderr, code));
          } else {
            resolve(stdout);
          }
        });
      });
    } finally {
      clearTimeout(timeoutId);
      if (requestId) {
        this._activeControllers.delete(requestId);
      }
    }
  }

  async search(query: string, projectPath: string, requestId?: string): Promise<SearchResult[]> {
    const raw = await this.runCommand(['search', query], projectPath, requestId);
    return parseSearchOutput(raw);
  }

  async map(projectPath: string, requestId?: string): Promise<RepoMapEntry[]> {
    const raw = await this.runCommand(['map'], projectPath, requestId);
    return parseMapOutput(raw);
  }

  async status(projectPath: string, requestId?: string): Promise<IndexStatus> {
    const raw = await this.runCommand(['status'], projectPath, requestId);
    return parseStatusOutput(raw);
  }

  async symbol(name: string, projectPath: string, requestId?: string): Promise<SymbolInfo> {
    const raw = await this.runCommand(['symbol', name], projectPath, requestId);
    return parseSymbolOutput(raw);
  }

  async callers(name: string, projectPath: string, requestId?: string): Promise<CallersResult> {
    const raw = await this.runCommand(['callers', name], projectPath, requestId);
    return parseCallersOutput(raw);
  }

  async callees(name: string, projectPath: string, requestId?: string): Promise<CalleesResult> {
    const raw = await this.runCommand(['callees', name], projectPath, requestId);
    return parseCalleesOutput(raw);
  }

  async context(name: string, projectPath: string, requestId?: string): Promise<ContextResult> {
    const raw = await this.runCommand(['context', name], projectPath, requestId);
    return parseContextOutput(raw);
  }

  async deadCode(projectPath: string, requestId?: string): Promise<DeadCodeResult[]> {
    const raw = await this.runCommand(['dead-code'], projectPath, requestId);
    return parseDeadCodeOutput(raw);
  }

  async testGaps(projectPath: string, requestId?: string): Promise<TestGapResult[]> {
    const raw = await this.runCommand(['test-gaps'], projectPath, requestId);
    return parseTestGapsOutput(raw);
  }

  async impact(name: string, projectPath: string, requestId?: string): Promise<ImpactResult> {
    const raw = await this.runCommand(['impact', name], projectPath, requestId);
    return parseImpactOutput(raw);
  }

  /**
   * Stream the index command output line by line.
   * The first line may be a non-structured banner ("Indexing /path/...") — skip it.
   * Calls onLine for each output line. Resolves when the process exits.
   */
  async index(
    projectPath: string,
    onLine: (line: string) => void,
    requestId?: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes for indexing
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    if (requestId) {
      this._activeControllers.set(requestId, controller);
    }

    try {
      return await new Promise<void>((resolve, reject) => {
        const { command, spawnArgs } = this._spawnArgs(['index', '.']);
        const child = spawn(command, spawnArgs, {
          cwd: projectPath,
          env: { ...process.env, CI: '1' },
          signal: controller.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const rl = createInterface({ input: child.stdout });
        const stderrChunks: Buffer[] = [];

        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        rl.on('line', (line: string) => {
          // Skip non-structured lines (e.g., "Indexing /path/...")
          if (line.trim() && line.includes('=')) {
            onLine(line);
          } else if (line.trim()) {
            // Pass through banner lines as opaque strings
            onLine(line);
          }
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.name === 'AbortError' || controller.signal.aborted) {
            reject(new CliBridgeError('Index command timed out or was cancelled', '', null));
          } else {
            reject(new CliBridgeError(err.message, '', null));
          }
        });

        child.on('close', (code: number | null) => {
          const stderr = Buffer.concat(stderrChunks).toString('utf8');
          if (code !== 0) {
            const msg = stderr.trim() || `Index command exited with code ${code}`;
            reject(new CliBridgeError(msg, stderr, code));
          } else {
            resolve();
          }
        });
      });
    } finally {
      clearTimeout(timeoutId);
      if (requestId) {
        this._activeControllers.delete(requestId);
      }
    }
  }
}
