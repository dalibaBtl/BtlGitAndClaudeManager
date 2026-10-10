import { describe, expect, it } from 'vitest';
import { isNoise } from '../src/server/watch.js';

describe('isNoise', () => {
  it('ignores object, reflog, hook, info and lock writes', () => {
    expect(isNoise('.git/objects/ab/cdef')).toBe(true);
    expect(isNoise('.git/logs/refs/remotes/origin/main')).toBe(true);
    expect(isNoise('.git/hooks/pre-commit.sample')).toBe(true);
    expect(isNoise('.git/info/exclude')).toBe(true);
    expect(isNoise('.git/index.lock')).toBe(true);
    expect(isNoise('.git/refs/heads/main.lock')).toBe(true);
  });

  it('keeps everything that can change status, ahead/behind or an operation', () => {
    for (const p of [
      '.git/index',
      '.git/HEAD',
      '.git/refs/heads/main',
      '.git/refs/remotes/origin/main',
      '.git/packed-refs',
      '.git/FETCH_HEAD',
      '.git/MERGE_HEAD',
      '.git/rebase-merge/done',
      '.git\\packed-refs',
    ]) {
      expect(isNoise(p), p).toBe(false);
    }
  });

  it('never treats working-tree paths as noise', () => {
    expect(isNoise('src/index.lock')).toBe(false);
    expect(isNoise('.gitignore')).toBe(false);
  });
});
