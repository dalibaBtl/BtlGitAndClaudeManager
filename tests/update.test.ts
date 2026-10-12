import { describe, expect, it } from 'vitest';
import {
  describeUpdate,
  parseCount,
  parseSubjects,
  updateState,
  type GitAnswers,
} from '../src/shared/update.js';

const clean: GitAnswers = {
  head: 'abc1234\n',
  branch: 'main\n',
  upstream: 'origin/main\n',
  status: '',
  behind: '3\n',
  log: 'Third\nSecond\nFirst\n',
  fetched: true,
};

describe('updateState', () => {
  it('reports a tracking clone that is behind', () => {
    const u = updateState('0.1.0', clean, 1000);
    expect(u).toEqual({
      version: '0.1.0',
      commit: 'abc1234',
      branch: 'main',
      behind: 3,
      subjects: ['Third', 'Second', 'First'],
      blocked: null,
      checkedAt: 1000,
    });
    expect(describeUpdate(u)).toBe('0.1.0 (abc1234, main), 3 commits behind');
  });

  it('blocks a dirty or detached clone and marks a failed fetch', () => {
    expect(updateState('0.1.0', { ...clean, status: ' M src/a.ts\n' }).blocked).toBe('dirty');
    expect(updateState('0.1.0', { ...clean, branch: 'HEAD\n' }).blocked).toBe('detached');
    expect(updateState('0.1.0', { ...clean, upstream: null }).blocked).toBe('detached');
    const offline = updateState('0.1.0', { ...clean, fetched: false });
    expect(offline.blocked).toBe('offline');
    expect(offline.behind).toBe(3);
    expect(describeUpdate(offline)).toContain('could not reach');
    expect(describeUpdate(updateState('0.1.0', { ...clean, status: ' M x' }))).toContain(
      'local changes',
    );
  });

  it('says up to date and copes with missing answers', () => {
    const u = updateState('0.1.0', { ...clean, behind: '0\n', log: '' });
    expect(describeUpdate(u)).toBe('0.1.0 (abc1234, main), up to date');
    expect(updateState('0.1.0', { ...clean, head: null, behind: null }).commit).toBe('unknown');
    expect(parseCount(null)).toBe(0);
    expect(parseCount('x')).toBe(0);
    expect(parseSubjects(null)).toEqual([]);
  });
});
