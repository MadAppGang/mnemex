import { parseKV } from './kv.js';
import type { RepoMapEntry } from '../types/messages.js';

/**
 * Parse the output of `claudemem map --agent`.
 *
 * Format:
 *   file=<path>
 *   symbol name=<string> kind=<string> line=<n> rank=<f>
 *   symbol name=<string> kind=<string> line=<n> rank=<f>
 *   file=<path>
 *   ...
 */
export function parseMapOutput(raw: string): RepoMapEntry[] {
  const entries: RepoMapEntry[] = [];
  let current: RepoMapEntry | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('file=')) {
      if (current) {
        entries.push(current);
      }
      current = {
        filePath: trimmed.slice('file='.length),
        symbols: [],
      };
    } else if (trimmed.startsWith('symbol ') && current) {
      const kv = parseKV(trimmed.slice('symbol '.length));
      current.symbols.push({
        name: kv['name'] ?? '',
        kind: kv['kind'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        rank: parseFloat(kv['rank'] ?? '0'),
      });
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}
