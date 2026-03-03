import { parseKV } from './kv.js';
import type { CalleesResult } from '../types/messages.js';

/**
 * Parse the output of `claudemem callees <name> --agent`.
 *
 * Format:
 *   symbol=<name>
 *   callee_count=<n>
 *   callee name=<string> file=<path> line=<n> kind=<string>
 *   ...
 */
export function parseCalleesOutput(raw: string): CalleesResult {
  let symbol = '';
  const callees: CalleesResult['callees'] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('symbol=')) {
      symbol = trimmed.slice('symbol='.length);
    } else if (trimmed.startsWith('callee ')) {
      const kv = parseKV(trimmed.slice('callee '.length));
      callees.push({
        name: kv['name'] ?? '',
        file: kv['file'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        kind: kv['kind'] ?? '',
      });
    }
  }

  return { symbol, callees };
}
