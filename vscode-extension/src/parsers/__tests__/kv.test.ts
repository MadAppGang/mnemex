import { describe, it, expect } from 'vitest';
import { parseKV, parsePrefix } from '../kv';

describe('parseKV', () => {
  it('parses a single key=value pair', () => {
    const result = parseKV('key=value');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses multiple key=value pairs separated by spaces', () => {
    const result = parseKV('file=src/foo.ts line=10 score=0.95');
    expect(result.file).toBe('src/foo.ts');
    expect(result.line).toBe('10');
    expect(result.score).toBe('0.95');
  });

  it('handles a value containing an = sign', () => {
    // Values that contain = should include the remainder after the first = on that token
    const result = parseKV('signature=foo(x=1)');
    // The key "signature" must be present
    expect(result).toHaveProperty('signature');
    // Its value must contain "foo" and the embedded = character
    expect(result.signature).toContain('foo');
    expect(result.signature).toContain('=');
  });

  it('handles file path with spaces', () => {
    const result = parseKV('file=/Users/John Doe/project/src/auth.ts line=5');
    expect(result.file).toBe('/Users/John Doe/project/src/auth.ts');
    expect(result.line).toBe('5');
  });

  it('returns an empty object for an empty string', () => {
    const result = parseKV('');
    expect(result).toEqual({});
  });

  it('handles a value with numeric content', () => {
    const result = parseKV('count=42');
    expect(result.count).toBe('42');
  });

  it('handles a value with float content', () => {
    const result = parseKV('score=0.9523');
    expect(result.score).toBe('0.9523');
  });

  it('handles boolean-like values', () => {
    const result = parseKV('exists=true exported=false');
    expect(result.exists).toBe('true');
    expect(result.exported).toBe('false');
  });

  it('handles multiple key=value pairs with no spaces in values', () => {
    const result = parseKV('name=myFunc kind=function line=42 rank=0.05');
    expect(result.name).toBe('myFunc');
    expect(result.kind).toBe('function');
    expect(result.line).toBe('42');
    expect(result.rank).toBe('0.05');
  });
});

describe('parsePrefix', () => {
  it('splits the prefix word from key=value remainder', () => {
    const result = parsePrefix('result file=src/foo.ts line=10');
    expect(result.prefix).toBe('result');
    expect(result.kv.file).toBe('src/foo.ts');
    expect(result.kv.line).toBe('10');
  });

  it('returns prefix only when line has no spaces', () => {
    const result = parsePrefix('eof');
    expect(result.prefix).toBe('eof');
    expect(result.kv).toEqual({});
  });

  it('handles caller prefix with multiple fields', () => {
    const result = parsePrefix('caller name=myFunc file=src/a.ts line=5 kind=function');
    expect(result.prefix).toBe('caller');
    expect(result.kv.name).toBe('myFunc');
    expect(result.kv.file).toBe('src/a.ts');
    expect(result.kv.line).toBe('5');
    expect(result.kv.kind).toBe('function');
  });

  it('handles symbol prefix with rank field', () => {
    const result = parsePrefix('symbol name=MyClass kind=class line=1 rank=0.12');
    expect(result.prefix).toBe('symbol');
    expect(result.kv.name).toBe('MyClass');
    expect(result.kv.kind).toBe('class');
    expect(result.kv.rank).toBe('0.12');
  });

  it('handles file path with spaces in prefix line', () => {
    const result = parsePrefix('caller name=login file=/Users/John Doe/project/src/auth.ts line=42 kind=function');
    expect(result.prefix).toBe('caller');
    expect(result.kv.file).toBe('/Users/John Doe/project/src/auth.ts');
    expect(result.kv.line).toBe('42');
  });
});
