import { describe, it, expect } from 'vitest';
import { parseSymbolOutput } from '../symbol';
import { parseCallersOutput } from '../callers';
import { parseCalleesOutput } from '../callees';
import { parseContextOutput } from '../context';

describe('parseSymbolOutput', () => {
  const fullOutput = [
    'symbol=authenticateUser',
    'file=src/auth.ts',
    'line=42',
    'end_line=78',
    'type=function',
    'exported=true',
    'pagerank=0.0523',
    'signature=function authenticateUser(email: string, password: string): Promise<User>',
  ].join('\n');

  it('parses full symbol output with all fields', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(sym.name).toBe('authenticateUser');
    expect(sym.file).toBe('src/auth.ts');
    expect(sym.line).toBe(42);
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(true);
    expect(sym.pagerank).toBeCloseTo(0.0523, 4);
    expect(sym.signature).toContain('authenticateUser');
  });

  it('parses end_line field', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(sym.endLine).toBe(78);
    expect(typeof sym.endLine).toBe('number');
  });

  it('parses exported as boolean true', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(typeof sym.exported).toBe('boolean');
    expect(sym.exported).toBe(true);
  });

  it('parses exported=false correctly', () => {
    const raw = [
      'symbol=internalHelper',
      'file=src/helpers.ts',
      'line=10',
      'end_line=20',
      'type=function',
      'exported=false',
      'pagerank=0.001',
    ].join('\n');

    const sym = parseSymbolOutput(raw);
    expect(sym.exported).toBe(false);
  });

  it('parses pagerank as float', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(typeof sym.pagerank).toBe('number');
    expect(sym.pagerank).toBeCloseTo(0.0523, 4);
  });

  it('parses line and endLine as integers', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(typeof sym.line).toBe('number');
    expect(sym.line).toBe(42);
    expect(typeof sym.endLine).toBe('number');
    expect(sym.endLine).toBe(78);
  });

  it('handles missing optional signature field', () => {
    const raw = [
      'symbol=MyClass',
      'file=src/model.ts',
      'line=1',
      'end_line=50',
      'type=class',
      'exported=true',
      'pagerank=0.08',
    ].join('\n');

    const sym = parseSymbolOutput(raw);
    expect(sym.signature).toBeUndefined();
  });

  it('handles file path with spaces', () => {
    const raw = [
      'symbol=login',
      'file=/Users/John Doe/project/src/auth.ts',
      'line=10',
      'end_line=30',
      'type=function',
      'exported=true',
      'pagerank=0.05',
    ].join('\n');

    const sym = parseSymbolOutput(raw);
    expect(sym.file).toBe('/Users/John Doe/project/src/auth.ts');
  });

  it('has name field mapped from symbol= line', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(sym.name).toBe('authenticateUser');
  });

  it('has kind field mapped from type= line', () => {
    const sym = parseSymbolOutput(fullOutput);
    expect(sym.kind).toBe('function');
  });
});

describe('parseCallersOutput', () => {
  it('parses output with multiple callers', () => {
    const raw = [
      'symbol=login',
      'caller_count=2',
      'caller name=handleAuth file=src/controller.ts line=15 kind=function',
      'caller name=testLogin file=src/auth.test.ts line=30 kind=function',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.symbol).toBe('login');
    expect(result.callers).toHaveLength(2);
    expect(result.callers[0].name).toBe('handleAuth');
    expect(result.callers[0].file).toBe('src/controller.ts');
    expect(result.callers[0].line).toBe(15);
    expect(result.callers[0].kind).toBe('function');
    expect(result.callers[1].name).toBe('testLogin');
  });

  it('returns empty callers array when caller_count=0', () => {
    const raw = 'symbol=isolatedFunc\ncaller_count=0\n';
    const result = parseCallersOutput(raw);
    expect(result.symbol).toBe('isolatedFunc');
    expect(result.callers).toEqual([]);
  });

  it('parses caller file path with spaces', () => {
    const raw = [
      'symbol=login',
      'caller_count=1',
      'caller name=handleAuth file=/Users/John Doe/project/src/controller.ts line=15 kind=function',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.callers[0].file).toBe('/Users/John Doe/project/src/controller.ts');
  });

  it('parses caller line as number', () => {
    const raw = [
      'symbol=foo',
      'caller_count=1',
      'caller name=bar file=src/a.ts line=99 kind=method',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(typeof result.callers[0].line).toBe('number');
    expect(result.callers[0].line).toBe(99);
  });

  it('handles single caller', () => {
    const raw = [
      'symbol=myFunc',
      'caller_count=1',
      'caller name=oneCaller file=src/a.ts line=5 kind=function',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0].name).toBe('oneCaller');
  });
});

describe('parseCalleesOutput', () => {
  it('parses output with multiple callees', () => {
    const raw = [
      'symbol=login',
      'callee_count=2',
      'callee name=validatePassword file=src/validators.ts line=5 kind=function',
      'callee name=generateToken file=src/token.ts line=12 kind=function',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(result.symbol).toBe('login');
    expect(result.callees).toHaveLength(2);
    expect(result.callees[0].name).toBe('validatePassword');
    expect(result.callees[0].file).toBe('src/validators.ts');
    expect(result.callees[0].line).toBe(5);
    expect(result.callees[0].kind).toBe('function');
    expect(result.callees[1].name).toBe('generateToken');
  });

  it('returns empty callees array when callee_count=0', () => {
    const raw = 'symbol=leafFunc\ncallee_count=0\n';
    const result = parseCalleesOutput(raw);
    expect(result.symbol).toBe('leafFunc');
    expect(result.callees).toEqual([]);
  });

  it('parses callee file path with spaces', () => {
    const raw = [
      'symbol=login',
      'callee_count=1',
      'callee name=validate file=/Users/John Doe/project/src/validate.ts line=7 kind=function',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(result.callees[0].file).toBe('/Users/John Doe/project/src/validate.ts');
  });

  it('parses callee line as number', () => {
    const raw = [
      'symbol=foo',
      'callee_count=1',
      'callee name=bar file=src/b.ts line=77 kind=method',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(typeof result.callees[0].line).toBe('number');
    expect(result.callees[0].line).toBe(77);
  });

  it('handles single callee', () => {
    const raw = [
      'symbol=myFunc',
      'callee_count=1',
      'callee name=helper file=src/utils.ts line=20 kind=function',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(result.callees).toHaveLength(1);
    expect(result.callees[0].name).toBe('helper');
  });
});

describe('parseContextOutput', () => {
  const fullContextRaw = [
    'symbol=login',
    'file=src/auth.ts',
    'line=42',
    'kind=function',
    'caller_count=2',
    'caller name=handleAuth file=src/controller.ts line=15',
    'caller name=testLogin file=src/auth.test.ts line=30',
    'callee_count=2',
    'callee name=validatePassword file=src/validators.ts line=5',
    'callee name=generateToken file=src/token.ts line=12',
  ].join('\n');

  it('parses context output with symbol info, callers, and callees', () => {
    const result = parseContextOutput(fullContextRaw);
    expect(result).toBeDefined();
    // Should have symbol information
    expect(result.symbol).toBeDefined();
    // Should have callers array
    expect(Array.isArray(result.callers)).toBe(true);
    // Should have callees array
    expect(Array.isArray(result.callees)).toBe(true);
  });

  it('parses the correct number of callers', () => {
    const result = parseContextOutput(fullContextRaw);
    expect(result.callers).toHaveLength(2);
  });

  it('parses the correct number of callees', () => {
    const result = parseContextOutput(fullContextRaw);
    expect(result.callees).toHaveLength(2);
  });

  it('returns empty callers and callees when counts are 0', () => {
    const raw = [
      'symbol=isolatedFunc',
      'file=src/util.ts',
      'line=1',
      'kind=function',
      'caller_count=0',
      'callee_count=0',
    ].join('\n');

    const result = parseContextOutput(raw);
    expect(result.callers).toEqual([]);
    expect(result.callees).toEqual([]);
  });

  it('caller entries have name, file, and line fields', () => {
    const result = parseContextOutput(fullContextRaw);
    const caller = result.callers[0];
    expect(caller).toHaveProperty('name');
    expect(caller).toHaveProperty('file');
    expect(caller).toHaveProperty('line');
  });

  it('callee entries have name, file, and line fields', () => {
    const result = parseContextOutput(fullContextRaw);
    const callee = result.callees[0];
    expect(callee).toHaveProperty('name');
    expect(callee).toHaveProperty('file');
    expect(callee).toHaveProperty('line');
  });

  it('symbol field is the symbol name as a string', () => {
    const result = parseContextOutput(fullContextRaw);
    expect(typeof result.symbol).toBe('string');
    expect(result.symbol).toBe('login');
  });
});
