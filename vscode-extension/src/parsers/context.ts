import { parseKV } from './kv.js';
import type { ContextResult } from '../types/messages.js';

/**
 * Parse the output of `claudemem context <name> --agent`.
 *
 * Format:
 *   symbol=<name>
 *   file=<path>
 *   line=<n>
 *   kind=<string>
 *   caller_count=<n>
 *   caller name=<string> file=<path> line=<n>
 *   ...
 *   callee_count=<n>
 *   callee name=<string> file=<path> line=<n>
 *   ...
 */
export function parseContextOutput(raw: string): ContextResult {
  let symbol = '';
  let file = '';
  let line = 0;
  let kind = '';
  const callers: ContextResult['callers'] = [];
  const callees: ContextResult['callees'] = [];

  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('symbol=')) {
      symbol = trimmed.slice('symbol='.length);
    } else if (trimmed.startsWith('file=')) {
      file = trimmed.slice('file='.length);
    } else if (trimmed.startsWith('line=')) {
      line = parseInt(trimmed.slice('line='.length), 10);
    } else if (trimmed.startsWith('kind=')) {
      kind = trimmed.slice('kind='.length);
    } else if (trimmed.startsWith('caller ')) {
      const kv = parseKV(trimmed.slice('caller '.length));
      callers.push({
        name: kv['name'] ?? '',
        file: kv['file'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        kind: kv['kind'],
      });
    } else if (trimmed.startsWith('callee ')) {
      const kv = parseKV(trimmed.slice('callee '.length));
      callees.push({
        name: kv['name'] ?? '',
        file: kv['file'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        kind: kv['kind'],
      });
    }
  }

  return { symbol, file, line, kind, callers, callees };
}
