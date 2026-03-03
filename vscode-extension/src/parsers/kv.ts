/**
 * Shared key=value parsing utilities used by all parsers.
 *
 * The claudemem --agent output has two line shapes:
 *   1. Simple:          key=value
 *   2. Multi-field:     prefix key1=value1 key2=value2 ...
 *
 * IMPORTANT: Values (especially file paths) may contain spaces.
 * We parse by locating key= boundaries using lookahead for " word=" patterns.
 */

/**
 * Parse a string of key=value pairs where values may contain spaces.
 *
 * Strategy: find all positions where "word=" appears (accounting for start-of-string
 * or a preceding space), then slice between consecutive key positions.
 *
 * Example: "file=/Users/John Doe/project/src/auth.ts line=42 score=0.9"
 * => { file: '/Users/John Doe/project/src/auth.ts', line: '42', score: '0.9' }
 */
export function parseKV(line: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Find all positions where a key starts: beginning of string or after a space,
  // followed by word characters and '='
  const keyPattern = /(?:^|\s)(\w+)=/g;
  const matches: Array<{ key: string; valueStart: number; boundaryPos: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = keyPattern.exec(line)) !== null) {
    const key = m[1];
    const valueStart = m.index + m[0].length;
    // boundaryPos is the position of the space before the key (or start of string)
    const boundaryPos = m.index;
    matches.push({ key, valueStart, boundaryPos });
  }

  for (let i = 0; i < matches.length; i++) {
    const { key, valueStart } = matches[i];
    // Value extends to the space before the next key, or end of string
    const valueEnd = i + 1 < matches.length ? matches[i + 1].boundaryPos : line.length;
    result[key] = line.slice(valueStart, valueEnd).trimEnd();
  }

  return result;
}

/**
 * Parse a line that starts with a prefix word followed by key=value pairs.
 *
 * Example: "result file=src/auth.ts line=42 score=0.923 type=function name=validateToken"
 * => { prefix: 'result', kv: { file: 'src/auth.ts', line: '42', ... } }
 */
export function parsePrefix(line: string): { prefix: string; kv: Record<string, string> } {
  const firstSpace = line.indexOf(' ');
  if (firstSpace === -1) {
    return { prefix: line, kv: {} };
  }
  return {
    prefix: line.slice(0, firstSpace),
    kv: parseKV(line.slice(firstSpace + 1)),
  };
}
