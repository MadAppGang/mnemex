import { describe, it, expect } from 'vitest';
import { parseDeadCodeOutput, parseTestGapsOutput, parseImpactOutput } from '../analysis';

describe('parseDeadCodeOutput', () => {
  it('returns empty array for empty string', () => {
    const results = parseDeadCodeOutput('');
    expect(results).toEqual([]);
  });

  it('returns empty array when dead_code_count=0', () => {
    const raw = 'dead_code_count=0\n';
    const results = parseDeadCodeOutput(raw);
    expect(results).toEqual([]);
  });

  it('parses multiple dead symbols', () => {
    const raw = [
      'dead_code_count=2',
      'dead_symbol name=unusedFn file=src/util.ts line=5 kind=function pagerank=0.0001',
      'dead_symbol name=DeadClass file=src/legacy.ts line=100 kind=class pagerank=0.0002',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results).toHaveLength(2);
  });

  it('parses dead symbol name correctly', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=unusedFn file=src/util.ts line=5 kind=function pagerank=0.0001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results[0].name).toBe('unusedFn');
  });

  it('parses dead symbol file correctly', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=foo file=src/foo.ts line=1 kind=function pagerank=0.0001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results[0].file).toBe('src/foo.ts');
  });

  it('parses dead symbol line as number', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=foo file=src/foo.ts line=42 kind=function pagerank=0.0001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(typeof results[0].line).toBe('number');
    expect(results[0].line).toBe(42);
  });

  it('parses dead symbol kind correctly', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=OldClass file=src/old.ts line=1 kind=class pagerank=0.0001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results[0].kind).toBe('class');
  });

  it('parses dead symbol pagerank as float', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=foo file=src/foo.ts line=1 kind=function pagerank=0.00015',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(typeof results[0].pagerank).toBe('number');
    expect(results[0].pagerank).toBeCloseTo(0.00015, 5);
  });

  it('parses dead symbol file path with spaces', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=foo file=/Users/John Doe/project/src/utils.ts line=5 kind=function pagerank=0.001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results[0].file).toBe('/Users/John Doe/project/src/utils.ts');
  });

  it('parses single dead symbol', () => {
    const raw = [
      'dead_code_count=1',
      'dead_symbol name=singleDead file=src/a.ts line=1 kind=function pagerank=0.0001',
    ].join('\n');

    const results = parseDeadCodeOutput(raw);
    expect(results).toHaveLength(1);
  });
});

describe('parseTestGapsOutput', () => {
  it('returns empty array for empty string', () => {
    const results = parseTestGapsOutput('');
    expect(results).toEqual([]);
  });

  it('returns empty array when test_gap_count=0', () => {
    const raw = 'test_gap_count=0\n';
    const results = parseTestGapsOutput(raw);
    expect(results).toEqual([]);
  });

  it('parses multiple test gap symbols', () => {
    const raw = [
      'test_gap_count=2',
      'test_gap name=login file=src/auth.ts line=10 kind=function pagerank=0.12 callers=5',
      'test_gap name=processPayment file=src/payment.ts line=42 kind=function pagerank=0.08 callers=3',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(results).toHaveLength(2);
  });

  it('parses test gap name correctly', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=criticalOp file=src/core.ts line=1 kind=function pagerank=0.15 callers=10',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(results[0].name).toBe('criticalOp');
  });

  it('parses test gap file correctly', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=foo file=src/core/engine.ts line=1 kind=method pagerank=0.1 callers=2',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(results[0].file).toBe('src/core/engine.ts');
  });

  it('parses test gap line as number', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=foo file=src/a.ts line=55 kind=function pagerank=0.1 callers=2',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(typeof results[0].line).toBe('number');
    expect(results[0].line).toBe(55);
  });

  it('parses test gap kind correctly', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=MyService file=src/service.ts line=1 kind=class pagerank=0.1 callers=2',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(results[0].kind).toBe('class');
  });

  it('parses test gap pagerank as float', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=foo file=src/a.ts line=1 kind=function pagerank=0.0852 callers=2',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(typeof results[0].pagerank).toBe('number');
    expect(results[0].pagerank).toBeCloseTo(0.0852, 4);
  });

  it('parses test gap callers as number', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=foo file=src/a.ts line=1 kind=function pagerank=0.1 callers=7',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(typeof results[0].callers).toBe('number');
    expect(results[0].callers).toBe(7);
  });

  it('parses test gap file path with spaces', () => {
    const raw = [
      'test_gap_count=1',
      'test_gap name=foo file=/Users/John Doe/project/src/core.ts line=1 kind=function pagerank=0.1 callers=3',
    ].join('\n');

    const results = parseTestGapsOutput(raw);
    expect(results[0].file).toBe('/Users/John Doe/project/src/core.ts');
  });
});

describe('parseImpactOutput', () => {
  it('parses symbol name from impact output', () => {
    const raw = 'symbol=coreUtil\naffected_count=0\n';
    const result = parseImpactOutput(raw);
    expect(result.symbol).toBe('coreUtil');
  });

  it('returns empty affected array when affected_count=0', () => {
    const raw = 'symbol=leafFunction\naffected_count=0\n';
    const result = parseImpactOutput(raw);
    expect(result.affected).toEqual([]);
  });

  it('parses multiple affected symbols', () => {
    const raw = [
      'symbol=coreEngine',
      'affected_count=3',
      'affected name=featureA file=src/featureA.ts line=5 kind=function',
      'affected name=featureB file=src/featureB.ts line=10 kind=method',
      'affected name=featureC file=src/featureC.ts line=15 kind=class',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.symbol).toBe('coreEngine');
    expect(result.affected).toHaveLength(3);
  });

  it('parses affected symbol name correctly', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=directCaller file=src/caller.ts line=5 kind=function',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.affected[0].name).toBe('directCaller');
  });

  it('parses affected symbol file correctly', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=bar file=src/bar/index.ts line=1 kind=function',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.affected[0].file).toBe('src/bar/index.ts');
  });

  it('parses affected symbol line as number', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=bar file=src/bar.ts line=88 kind=function',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(typeof result.affected[0].line).toBe('number');
    expect(result.affected[0].line).toBe(88);
  });

  it('parses affected symbol kind correctly', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=bar file=src/bar.ts line=1 kind=method',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.affected[0].kind).toBe('method');
  });

  it('parses affected file path with spaces', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=bar file=/Users/John Doe/project/src/utils.ts line=5 kind=function',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.affected[0].file).toBe('/Users/John Doe/project/src/utils.ts');
  });

  it('handles single affected symbol', () => {
    const raw = [
      'symbol=foo',
      'affected_count=1',
      'affected name=onlyAffected file=src/a.ts line=1 kind=function',
    ].join('\n');

    const result = parseImpactOutput(raw);
    expect(result.affected).toHaveLength(1);
  });
});
