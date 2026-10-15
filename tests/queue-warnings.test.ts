import { describe, expect, it } from 'vitest';
import type { PreparedCommit } from '../src/shared/types.js';
import { queueWarnings } from '../src/web/queue-warnings.js';

const item = (id: string, files: string[], message = id): PreparedCommit => ({
  version: 1,
  id,
  message,
  files,
  createdBy: 't',
  createdAt: '',
});

describe('queueWarnings', () => {
  it('is silent when every file still has changes and nothing is shared', () => {
    const a = item('a', ['x.ts']);
    expect(queueWarnings(a, [a, item('b', ['y.ts'])], new Set(['x.ts', 'y.ts']))).toEqual([]);
  });

  it('flags files without changes, partially and completely', () => {
    const a = item('a', ['x.ts', 'gone.ts']);
    expect(queueWarnings(a, [a], new Set(['x.ts']))).toEqual([
      '1 of 2 files have no changes and will be skipped: gone.ts',
    ]);
    expect(queueWarnings(a, [a], new Set())).toEqual([
      'nothing to commit: none of its files have changes',
    ]);
  });

  it('flags files shared with another prepared commit', () => {
    const a = item('a', ['x.ts', 'y.ts']);
    const b = item('b', ['y.ts'], 'second one');
    const w = queueWarnings(a, [a, b], new Set(['x.ts', 'y.ts']));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('1 file(s) also in another prepared commit');
    expect(w[0]).toContain('y.ts');
  });

  it('warns that an all-changes commit swallows the other entries, or has nothing', () => {
    const all = item('all', []);
    const b = item('b', ['y.ts']);
    expect(queueWarnings(all, [all, b], new Set(['y.ts']))).toEqual([
      'stages everything, including files of the other prepared commits',
    ]);
    expect(queueWarnings(all, [all], new Set())).toEqual([
      'nothing to commit: the working tree is clean',
    ]);
    expect(queueWarnings(all, [all], new Set(['y.ts']))).toEqual([]);
  });
});
