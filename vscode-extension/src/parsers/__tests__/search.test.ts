import { describe, it, expect } from 'vitest';
import { parseSearchOutput } from '../search';

describe('parseSearchOutput', () => {
  it('returns empty array for empty string', () => {
    const results = parseSearchOutput('');
    expect(results).toEqual([]);
  });

  it('returns empty array when result_count is 0 and no result lines', () => {
    const raw = 'query=hello world\nresult_count=0\n';
    const results = parseSearchOutput(raw);
    expect(results).toEqual([]);
  });

  it('parses a single result with all required fields', () => {
    const raw = [
      'query=authenticate user',
      'result_count=1',
      'result file=src/auth.ts line=42 score=0.95 type=function name=authenticateUser',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('src/auth.ts');
    expect(results[0].line).toBe(42);
    expect(results[0].score).toBe(0.95);
    expect(results[0].type).toBe('function');
    expect(results[0].name).toBe('authenticateUser');
  });

  it('parses multiple results', () => {
    const raw = [
      'query=login',
      'result_count=3',
      'result file=src/auth.ts line=10 score=0.99 type=function name=login',
      'result file=src/user.ts line=55 score=0.88 type=method name=loginUser',
      'result file=src/session.ts line=20 score=0.75 type=class name=LoginSession',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results).toHaveLength(3);
    expect(results[0].name).toBe('login');
    expect(results[1].name).toBe('loginUser');
    expect(results[2].name).toBe('LoginSession');
  });

  it('parses result with optional summary field', () => {
    const raw = [
      'query=auth',
      'result_count=1',
      'result file=src/auth.ts line=1 score=0.9 type=function name=doAuth summary=Authenticates the user against the database',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].summary).toBe('Authenticates the user against the database');
  });

  it('result without summary field has undefined summary', () => {
    const raw = [
      'query=auth',
      'result_count=1',
      'result file=src/auth.ts line=1 score=0.9 type=function name=doAuth',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].summary).toBeUndefined();
  });

  it('parses line as a number', () => {
    const raw = 'result file=src/a.ts line=123 score=0.5 type=function name=foo';
    const results = parseSearchOutput(raw);
    expect(typeof results[0].line).toBe('number');
    expect(results[0].line).toBe(123);
  });

  it('parses score as a number', () => {
    const raw = 'result file=src/a.ts line=1 score=0.8523 type=function name=foo';
    const results = parseSearchOutput(raw);
    expect(typeof results[0].score).toBe('number');
    expect(results[0].score).toBeCloseTo(0.8523, 4);
  });

  it('handles file path with spaces', () => {
    const raw = [
      'query=login',
      'result_count=1',
      'result file=/Users/John Doe/project/src/auth.ts line=42 score=0.9 type=function name=login',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('/Users/John Doe/project/src/auth.ts');
    expect(results[0].line).toBe(42);
  });

  it('ignores non-result lines (query=, result_count=)', () => {
    const raw = [
      'query=foo',
      'result_count=1',
      'result file=src/a.ts line=1 score=0.5 type=function name=foo',
    ].join('\n');

    const results = parseSearchOutput(raw);
    // Should only produce results for the result lines, not for query= or result_count=
    expect(results).toHaveLength(1);
  });

  it('handles mixed optional summary across multiple results', () => {
    const raw = [
      'query=auth',
      'result_count=2',
      'result file=src/a.ts line=1 score=0.9 type=function name=doAuth summary=Auth handler',
      'result file=src/b.ts line=5 score=0.8 type=function name=checkAuth',
    ].join('\n');

    const results = parseSearchOutput(raw);
    expect(results[0].summary).toBe('Auth handler');
    expect(results[1].summary).toBeUndefined();
  });
});
