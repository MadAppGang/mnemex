import { parseKV } from './kv.js';
import type { CallersResult } from '../types/messages.js';

/**
 * Parse the output of `claudemem callers <name> --agent`.
 *
 * Format:
 *   symbol=<name>
 *   caller_count=<n>
 *   caller name=<string> file=<path> line=<n> kind=<string>
 *   ...
 */
export function parseCallersOutput(raw: string): CallersResult {
  let symbol = '';
  const callers: CallersResult['callers'] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('symbol=')) {
      symbol = trimmed.slice('symbol='.length);
    } else if (trimmed.startsWith('caller ')) {
      const kv = parseKV(trimmed.slice('caller '.length));
      callers.push({
        name: kv['name'] ?? '',
        file: kv['file'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        kind: kv['kind'] ?? '',
      });
    }
  }

  return { symbol, callers };
}
