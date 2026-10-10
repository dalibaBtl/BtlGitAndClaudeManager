import { describe, expect, it } from 'vitest';
import { parseLogRecord } from '../src/server/git.js';

describe('parseLogRecord', () => {
  const rec =
    ['abc123', 'abc', 'Jan', '1700000000', 'feat: thing', 'feat: thing\n\nBody line.\n\n'].join(
      '\x1f',
    ) +
    '\x1d\n' +
    ['M\tsrc/a.ts', 'R100\told.ts\tnew.ts', ''].join('\n');

  it('separates the multi-line body from the name-status list', () => {
    const c = parseLogRecord(rec, 'abc123', new Set(['abc123']));
    expect(c.subject).toBe('feat: thing');
    expect(c.message).toBe('feat: thing\n\nBody line.');
    expect(c.files).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', origPath: 'old.ts', path: 'new.ts' },
    ]);
    expect(c.isHead).toBe(true);
    expect(c.pushed).toBe(false);
  });

  it('marks commits pushed only when an upstream exists and lacks them', () => {
    expect(parseLogRecord(rec, 'other', new Set()).pushed).toBe(true);
    expect(parseLogRecord(rec, 'other', null).pushed).toBe(false);
    expect(parseLogRecord(rec, 'other', null).isHead).toBe(false);
  });
});
