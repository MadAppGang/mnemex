// test/helpers/test-workspace.ts

import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync,
} from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createFileTracker, type IFileTracker } from "../../src/core/tracker.js";
import { ReferenceGraphManager, createReferenceGraphManager } from "../../src/core/reference-graph.js";
import { createSymbolExtractor } from "../../src/core/symbol-extractor.js";
import { getParserManager, type ParserManager } from "../../src/parsers/parser-manager.js";
import type { IndexCache, CachedIndex } from "../../src/mcp/cache.js";
import type { McpConfig } from "../../src/mcp/config.js";
import { SymbolEditor } from "../../src/editor/editor.js";
import { MemoryStore } from "../../src/memory/store.js";

export interface IndexedWorkspace {
  tracker: IFileTracker;
  graphManager: ReferenceGraphManager;
  cache: IndexCache;
  config: McpConfig;
}

export class TestWorkspace {
  readonly root: string;
  readonly indexDir: string;
  private readonly dbPath: string;
  private _cache: IndexCache | null = null;
  private _config: McpConfig;

  private constructor(root: string) {
    this.root = root;
    this.indexDir = join(root, ".claudemem");
    this.dbPath = join(this.indexDir, "index.db");
    mkdirSync(this.indexDir, { recursive: true });
    this._config = {
      workspaceRoot: this.root,
      indexDir: this.indexDir,
      debounceMs: 120000,
      watchPatterns: ["**/*.ts"],
      ignorePatterns: ["node_modules/**"],
      maxMemoryMB: 500,
      completionPollMs: 2000,
      logLevel: "error",
      lsp: {
        enabled: false,
        timeoutMs: 10000,
        maxServers: 2,
        disabledLanguages: [],
      },
    } as McpConfig;
  }

  static create(prefix = "test-workspace"): TestWorkspace {
    const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    return new TestWorkspace(root);
  }

  /** Write a source file. Returns absolute path. */
  writeFile(relativePath: string, content: string): string {
    const absPath = join(this.root, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    return absPath;
  }

  /** Run the REAL indexing pipeline in-process */
  async index(): Promise<IndexedWorkspace> {
    const pm = getParserManager();
    await pm.initialize();

    const tracker = createFileTracker(this.dbPath, this.root);
    const extractor = createSymbolExtractor();

    await this._walkAndIndex(tracker, extractor, pm);

    tracker.resolveReferencesByName();

    const graphManager = createReferenceGraphManager(tracker);

    const cachedIndex: CachedIndex = {
      tracker,
      graphManager,
      repoMapGen: null!,
      loadedAt: Date.now(),
    };

    const cache: IndexCache = {
      get: async () => cachedIndex,
      invalidate: () => {},
      close: () => { tracker.close(); },
    } as unknown as IndexCache;

    this._cache = cache;

    return { tracker, graphManager, cache, config: this._config };
  }

  getCache(): IndexCache {
    if (!this._cache) {
      throw new Error("TestWorkspace: call index() before getCache()");
    }
    return this._cache;
  }

  getConfig(): McpConfig {
    return this._config;
  }

  createEditor(): SymbolEditor {
    return new SymbolEditor(this.getCache(), this.getConfig(), null);
  }

  createMemoryStore(): MemoryStore {
    return new MemoryStore(this.indexDir);
  }

  cleanup(): void {
    try {
      if (this._cache) {
        this._cache.close();
        this._cache = null;
      }
    } catch {
      // best effort
    }
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  // Static factory methods for generating TypeScript source
  static tsFunction(name: string, body = "return 0;", params = "a: number, b: number"): string {
    return `export function ${name}(${params}): number {\n  ${body}\n}\n`;
  }

  static tsClass(className: string, methodName = "process", methodBody = "return this;"): string {
    return (
      `export class ${className} {\n` +
      `  ${methodName}(): this {\n` +
      `    ${methodBody}\n` +
      `  }\n` +
      `}\n`
    );
  }

  static tsConst(name: string, value = "42"): string {
    return `export const ${name} = ${value};\n`;
  }

  static tsInterface(name: string, fields = "id: string;"): string {
    return `export interface ${name} {\n  ${fields}\n}\n`;
  }

  private async _walkAndIndex(
    tracker: IFileTracker,
    extractor: ReturnType<typeof createSymbolExtractor>,
    pm: ParserManager,
  ): Promise<void> {
    const SUPPORTED_EXTENSIONS = new Set([
      ".ts", ".tsx", ".mts", ".cts",
      ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".go", ".rs", ".c", ".cpp", ".h", ".java",
    ]);

    const walk = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".claudemem" && entry.name !== "node_modules") {
            results.push(...walk(fullPath));
          }
        } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const files = walk(this.root);

    for (const absPath of files) {
      const relPath = relative(this.root, absPath);
      const lang = pm.getLanguage(absPath);
      if (!lang) continue;

      const content = readFileSync(absPath, "utf-8");

      const symbols = await extractor.extractSymbols(content, relPath, lang);
      if (symbols.length > 0) {
        tracker.insertSymbols(symbols);

        const refs = await extractor.extractReferences(content, relPath, lang, symbols);
        if (refs.length > 0) {
          tracker.insertReferences(refs);
        }
      }

      // Record file state for TOCTOU hash check in SymbolEditor
      const hash = createHash("sha256").update(content).digest("hex");
      tracker.markIndexed(relPath, hash, []);
    }
  }
}
