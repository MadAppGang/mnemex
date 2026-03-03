import { describe, it, expect } from 'vitest';
import { parseStatusOutput } from '../status';

describe('parseStatusOutput', () => {
  it('parses full status output with all fields', () => {
    const raw = [
      'exists=true',
      'files=123',
      'chunks=456',
      'languages=typescript,javascript,python',
      'model=text-embedding-3-small',
      'last_updated=2026-03-03T10:00:00.000Z',
    ].join('\n');

    const status = parseStatusOutput(raw);
    expect(status.exists).toBe(true);
    expect(status.files).toBe(123);
    expect(status.chunks).toBe(456);
    expect(status.languages).toEqual(['typescript', 'javascript', 'python']);
    expect(status.model).toBe('text-embedding-3-small');
    expect(status.lastUpdated).toBe('2026-03-03T10:00:00.000Z');
  });

  it('parses exists=false with no other fields', () => {
    const raw = 'exists=false\n';
    const status = parseStatusOutput(raw);
    expect(status.exists).toBe(false);
    expect(status.files).toBeUndefined();
    expect(status.chunks).toBeUndefined();
    expect(status.languages).toBeUndefined();
    expect(status.model).toBeUndefined();
    expect(status.lastUpdated).toBeUndefined();
  });

  it('parses exists as boolean true', () => {
    const raw = 'exists=true';
    const status = parseStatusOutput(raw);
    expect(typeof status.exists).toBe('boolean');
    expect(status.exists).toBe(true);
  });

  it('parses exists as boolean false', () => {
    const raw = 'exists=false';
    const status = parseStatusOutput(raw);
    expect(typeof status.exists).toBe('boolean');
    expect(status.exists).toBe(false);
  });

  it('parses files as a number', () => {
    const raw = 'exists=true\nfiles=250\nchunks=1000';
    const status = parseStatusOutput(raw);
    expect(typeof status.files).toBe('number');
    expect(status.files).toBe(250);
  });

  it('parses chunks as a number', () => {
    const raw = 'exists=true\nfiles=10\nchunks=999';
    const status = parseStatusOutput(raw);
    expect(typeof status.chunks).toBe('number');
    expect(status.chunks).toBe(999);
  });

  it('parses languages as an array from CSV', () => {
    const raw = 'exists=true\nfiles=1\nchunks=5\nlanguages=typescript,go,rust';
    const status = parseStatusOutput(raw);
    expect(Array.isArray(status.languages)).toBe(true);
    expect(status.languages).toContain('typescript');
    expect(status.languages).toContain('go');
    expect(status.languages).toContain('rust');
  });

  it('handles single language as array with one entry', () => {
    const raw = 'exists=true\nfiles=1\nchunks=5\nlanguages=typescript';
    const status = parseStatusOutput(raw);
    expect(Array.isArray(status.languages)).toBe(true);
    expect(status.languages).toContain('typescript');
  });

  it('handles empty string gracefully', () => {
    const status = parseStatusOutput('');
    // Should not throw. exists should be a boolean or undefined.
    expect(status).toBeDefined();
    // exists=false is the safe fallback when no data
    expect(status.exists).toBeFalsy();
  });

  it('handles only files and chunks without languages and model', () => {
    const raw = 'exists=true\nfiles=50\nchunks=200';
    const status = parseStatusOutput(raw);
    expect(status.exists).toBe(true);
    expect(status.files).toBe(50);
    expect(status.chunks).toBe(200);
    expect(status.languages).toBeUndefined();
    expect(status.model).toBeUndefined();
  });
});
