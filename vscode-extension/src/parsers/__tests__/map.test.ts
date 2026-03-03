import { describe, it, expect } from 'vitest';
import { parseMapOutput } from '../map';

describe('parseMapOutput', () => {
  it('returns empty array for empty string', () => {
    const results = parseMapOutput('');
    expect(results).toEqual([]);
  });

  it('returns empty array when no file= lines present', () => {
    const results = parseMapOutput('some_other_key=value\n');
    expect(results).toEqual([]);
  });

  it('parses a single file with multiple symbols', () => {
    const raw = [
      'file=src/auth.ts',
      'symbol name=login kind=function line=10 rank=0.05',
      'symbol name=logout kind=function line=25 rank=0.03',
      'symbol name=AuthService kind=class line=1 rank=0.12',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('src/auth.ts');
    expect(results[0].symbols).toHaveLength(3);
  });

  it('parses symbol fields with correct types', () => {
    const raw = [
      'file=src/auth.ts',
      'symbol name=myFunc kind=function line=42 rank=0.05',
    ].join('\n');

    const results = parseMapOutput(raw);
    const sym = results[0].symbols[0];
    expect(sym.name).toBe('myFunc');
    expect(sym.kind).toBe('function');
    expect(sym.line).toBe(42);
    expect(typeof sym.line).toBe('number');
    expect(sym.rank).toBeCloseTo(0.05, 4);
    expect(typeof sym.rank).toBe('number');
  });

  it('parses multiple files', () => {
    const raw = [
      'file=src/auth.ts',
      'symbol name=login kind=function line=10 rank=0.05',
      'file=src/user.ts',
      'symbol name=User kind=class line=1 rank=0.08',
      'file=src/session.ts',
      'symbol name=Session kind=interface line=5 rank=0.02',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results).toHaveLength(3);
    expect(results[0].filePath).toBe('src/auth.ts');
    expect(results[1].filePath).toBe('src/user.ts');
    expect(results[2].filePath).toBe('src/session.ts');
  });

  it('correctly groups symbols under their respective files', () => {
    const raw = [
      'file=src/a.ts',
      'symbol name=alpha kind=function line=1 rank=0.1',
      'symbol name=beta kind=function line=5 rank=0.2',
      'file=src/b.ts',
      'symbol name=gamma kind=class line=1 rank=0.3',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results[0].symbols).toHaveLength(2);
    expect(results[0].symbols[0].name).toBe('alpha');
    expect(results[0].symbols[1].name).toBe('beta');
    expect(results[1].symbols).toHaveLength(1);
    expect(results[1].symbols[0].name).toBe('gamma');
  });

  it('handles file with no symbols', () => {
    const raw = [
      'file=src/empty.ts',
      'file=src/auth.ts',
      'symbol name=login kind=function line=1 rank=0.05',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results).toHaveLength(2);
    expect(results[0].filePath).toBe('src/empty.ts');
    expect(results[0].symbols).toHaveLength(0);
    expect(results[1].symbols).toHaveLength(1);
  });

  it('handles file path with spaces', () => {
    const raw = [
      'file=/Users/John Doe/project/src/auth.ts',
      'symbol name=login kind=function line=1 rank=0.05',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/Users/John Doe/project/src/auth.ts');
  });

  it('parses high pagerank symbol correctly', () => {
    const raw = [
      'file=src/core.ts',
      'symbol name=CoreEngine kind=class line=1 rank=0.156',
    ].join('\n');

    const results = parseMapOutput(raw);
    expect(results[0].symbols[0].rank).toBeCloseTo(0.156, 3);
  });
});
