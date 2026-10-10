import { describe, expect, it } from 'vitest';
import type { CommitInfo, RepoSummary } from '../src/shared/types.js';
import { historyBlockers } from '../src/web/commit-actions.js';

const commit = (sha: string, isHead: boolean, pushed: boolean): CommitInfo => ({
  sha,
  shortSha: sha.slice(0, 7),
  author: 'a',
  time: 0,
  subject: sha,
  message: sha,
  isHead,
  pushed,
  files: [],
});

const status = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  path: '/r',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  dirtyCount: 0,
  conflicts: 0,
  operation: null,
  ...over,
});

describe('historyBlockers', () => {
  const log = [commit('c3', true, false), commit('c2', false, false), commit('c1', false, true)];

  it('allows reset and checkout to an older commit when clean and nothing after it is pushed', () => {
    expect(historyBlockers(log[1]!, status(), log)).toEqual({
      reset: null,
      checkout: null,
      revert: null,
    });
  });

  it('refuses to reset over pushed commits but still allows checkout', () => {
    const pushedTop = [
      commit('c3', true, true),
      commit('c2', false, true),
      commit('c1', false, true),
    ];
    const b = historyBlockers(pushedTop[2]!, status(), pushedTop);
    expect(b.reset).toBe('newer commits are already pushed');
    expect(b.checkout).toBeNull();
  });

  it('blocks reset and checkout on a dirty tree, never revert', () => {
    const b = historyBlockers(log[1]!, status({ dirtyCount: 2 }), log);
    expect(b.reset).toBe('commit or stash changes first');
    expect(b.checkout).toBe('commit or stash changes first');
    expect(b.revert).toBeNull();
  });

  it('has nothing to do for HEAD and blocks reset while detached', () => {
    expect(historyBlockers(log[0]!, status(), log).reset).toBe('already at this commit');
    expect(historyBlockers(log[0]!, status(), log).checkout).toBe('already at this commit');
    expect(historyBlockers(log[1]!, status({ branch: null }), log).reset).toBe('HEAD is detached');
  });
});
