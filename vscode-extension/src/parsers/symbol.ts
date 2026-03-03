import { parseKV } from './kv.js';
import type { SymbolInfo } from '../types/messages.js';

/**
 * Parse the output of `claudemem symbol <name> --agent`.
 *
 * Format:
 *   symbol=<name>
 *   file=<path>
 *   line=<n>
 *   end_line=<n>
 *   type=<kind>
 *   exported=<bool>
 *   pagerank=<f>
 *   [signature=<string>]
 */
export function parseSymbolOutput(raw: string): SymbolInfo {
  const kv = parseKV(raw.replace(/\n/g, ' '));

  return {
    name: kv['symbol'] ?? '',
    file: kv['file'] ?? '',
    line: parseInt(kv['line'] ?? '0', 10),
    endLine: parseInt(kv['end_line'] ?? '0', 10),
    kind: kv['type'] ?? '',
    exported: kv['exported'] === 'true',
    pagerank: parseFloat(kv['pagerank'] ?? '0'),
    signature: kv['signature'],
  };
}
