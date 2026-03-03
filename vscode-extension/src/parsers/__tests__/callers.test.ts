import { describe, it, expect } from 'vitest';
import { parseCallersOutput } from '../callers';
import { parseCalleesOutput } from '../callees';

// Note: These tests duplicate the callers/callees coverage from symbol.test.ts
// but are kept here as a dedicated file for clarity and completeness.

describe('parseCallersOutput — dedicated file', () => {
  it('parses symbol name correctly', () => {
    const raw = 'symbol=myExportedFunc\ncaller_count=0\n';
    const result = parseCallersOutput(raw);
    expect(result.symbol).toBe('myExportedFunc');
  });

  it('parses three callers', () => {
    const raw = [
      'symbol=coreService',
      'caller_count=3',
      'caller name=featureA file=src/featureA.ts line=10 kind=function',
      'caller name=featureB file=src/featureB.ts line=20 kind=method',
      'caller name=featureC file=src/featureC.ts line=30 kind=function',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.callers).toHaveLength(3);
    expect(result.callers[2].name).toBe('featureC');
    expect(result.callers[2].line).toBe(30);
  });

  it('handles caller kind field correctly', () => {
    const raw = [
      'symbol=foo',
      'caller_count=2',
      'caller name=a file=src/a.ts line=1 kind=method',
      'caller name=b file=src/b.ts line=2 kind=class',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.callers[0].kind).toBe('method');
    expect(result.callers[1].kind).toBe('class');
  });

  it('handles Windows-style absolute path', () => {
    const raw = [
      'symbol=foo',
      'caller_count=1',
      'caller name=bar file=C:/Users/dev/project/src/auth.ts line=5 kind=function',
    ].join('\n');

    const result = parseCallersOutput(raw);
    expect(result.callers[0].file).toContain('auth.ts');
  });

  it('returns correct symbol when raw has trailing newline', () => {
    const raw = 'symbol=func\ncaller_count=0\n\n';
    const result = parseCallersOutput(raw);
    expect(result.symbol).toBe('func');
    expect(result.callers).toHaveLength(0);
  });
});

describe('parseCalleesOutput — dedicated file', () => {
  it('parses symbol name correctly', () => {
    const raw = 'symbol=rootFunc\ncallee_count=0\n';
    const result = parseCalleesOutput(raw);
    expect(result.symbol).toBe('rootFunc');
  });

  it('parses three callees', () => {
    const raw = [
      'symbol=orchestrator',
      'callee_count=3',
      'callee name=stepA file=src/stepA.ts line=1 kind=function',
      'callee name=stepB file=src/stepB.ts line=5 kind=function',
      'callee name=stepC file=src/stepC.ts line=10 kind=function',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(result.callees).toHaveLength(3);
    expect(result.callees[0].name).toBe('stepA');
    expect(result.callees[1].name).toBe('stepB');
    expect(result.callees[2].name).toBe('stepC');
  });

  it('handles callee kind field correctly', () => {
    const raw = [
      'symbol=foo',
      'callee_count=1',
      'callee name=util file=src/util.ts line=1 kind=interface',
    ].join('\n');

    const result = parseCalleesOutput(raw);
    expect(result.callees[0].kind).toBe('interface');
  });
});
