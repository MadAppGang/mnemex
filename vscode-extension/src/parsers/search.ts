import { parseKV } from './kv.js';
import type { SearchResult } from '../types/messages.js';

/**
 * Parse the output of `claudemem search --agent`.
 *
 * Format:
 *   query=<string>
 *   result_count=<n>
 *   result file=<path> line=<n> score=<f> type=<chunkType> name=<string> [summary=<string>]
 *   ...
 */
export function parseSearchOutput(raw: string): SearchResult[] {
  const results: SearchResult[] = [];

  for (const line of raw.split('\n')) {
    if (!line.startsWith('result ')) {
      continue;
    }
    const kv = parseKV(line.slice('result '.length));
    results.push({
      file: kv['file'] ?? '',
      line: parseInt(kv['line'] ?? '0', 10),
      score: parseFloat(kv['score'] ?? '0'),
      type: kv['type'] ?? '',
      name: kv['name'] ?? '',
      summary: kv['summary'],
    });
  }

  return results;
}
