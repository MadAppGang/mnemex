import { parseKV } from './kv.js';
import type { DeadCodeResult, TestGapResult, ImpactResult } from '../types/messages.js';

/**
 * Parse the output of `claudemem dead-code --agent`.
 *
 * Format:
 *   dead_code_count=<n>
 *   dead_symbol name=<string> file=<path> line=<n> kind=<string> pagerank=<f>
 *   ...
 */
export function parseDeadCodeOutput(raw: string): DeadCodeResult[] {
  const items: DeadCodeResult[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('dead_symbol ')) {
      continue;
    }
    const kv = parseKV(trimmed.slice('dead_symbol '.length));
    items.push({
      name: kv['name'] ?? '',
      file: kv['file'] ?? '',
      line: parseInt(kv['line'] ?? '0', 10),
      kind: kv['kind'] ?? '',
      pagerank: parseFloat(kv['pagerank'] ?? '0'),
    });
  }

  return items;
}

/**
 * Parse the output of `claudemem test-gaps --agent`.
 *
 * Format:
 *   test_gap_count=<n>
 *   test_gap name=<string> file=<path> line=<n> kind=<string> pagerank=<f> callers=<n>
 *   ...
 */
export function parseTestGapsOutput(raw: string): TestGapResult[] {
  const items: TestGapResult[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('test_gap ')) {
      continue;
    }
    const kv = parseKV(trimmed.slice('test_gap '.length));
    items.push({
      name: kv['name'] ?? '',
      file: kv['file'] ?? '',
      line: parseInt(kv['line'] ?? '0', 10),
      kind: kv['kind'] ?? '',
      pagerank: parseFloat(kv['pagerank'] ?? '0'),
      callers: parseInt(kv['callers'] ?? '0', 10),
    });
  }

  return items;
}

/**
 * Parse the output of `claudemem impact <name> --agent`.
 *
 * Format:
 *   symbol=<name>
 *   affected_count=<n>
 *   affected name=<string> file=<path> line=<n> kind=<string>
 *   ...
 */
export function parseImpactOutput(raw: string): ImpactResult {
  let symbol = '';
  const affected: ImpactResult['affected'] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('symbol=')) {
      symbol = trimmed.slice('symbol='.length);
    } else if (trimmed.startsWith('affected ')) {
      const kv = parseKV(trimmed.slice('affected '.length));
      affected.push({
        name: kv['name'] ?? '',
        file: kv['file'] ?? '',
        line: parseInt(kv['line'] ?? '0', 10),
        kind: kv['kind'] ?? '',
      });
    }
  }

  return { symbol, affected };
}
