import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectOperation } from '../src/server/git.js';

describe('detectOperation', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'bgcm-op-'));
    await mkdir(path.join(repo, '.git'));
  });
  afterEach(() => rm(repo, { recursive: true, force: true }));

  it('reports nothing for a quiet repo', async () => {
    expect(await detectOperation(repo)).toBeNull();
  });

  it('recognises each marker, rebase taking precedence', async () => {
    await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), 'abc\n');
    expect(await detectOperation(repo)).toBe('merge');
    await mkdir(path.join(repo, '.git', 'rebase-merge'));
    expect(await detectOperation(repo)).toBe('rebase');
    await rm(path.join(repo, '.git', 'rebase-merge'), { recursive: true });
    await rm(path.join(repo, '.git', 'MERGE_HEAD'));
    await writeFile(path.join(repo, '.git', 'CHERRY_PICK_HEAD'), 'abc\n');
    expect(await detectOperation(repo)).toBe('cherry-pick');
  });

  it('follows a .git file to the linked worktree directory', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'bgcm-wt-'));
    try {
      await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
      await writeFile(path.join(repo, '.git', 'REVERT_HEAD'), 'abc\n');
      expect(await detectOperation(wt)).toBe('revert');
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('returns null outside a repo', async () => {
    expect(await detectOperation(path.join(repo, 'nope'))).toBeNull();
  });
});
