import { describe, expect, it } from 'vitest';
import { parsePorcelainV2, statusLetter } from '../src/shared/porcelain.js';

const NUL = '\0';

describe('parsePorcelainV2', () => {
  it('parses branch headers and ordinary, renamed, untracked and ignored entries', () => {
    const raw = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 h1 h2 src/a.ts',
      '1 A. N... 000000 100644 100644 0 h3 new file.txt',
      '2 R. N... 100644 100644 100644 h4 h5 R100 new.ts',
      'old.ts',
      '? untracked.md',
      '! ignored.log',
    ].join(NUL);
    const st = parsePorcelainV2(raw, '/repo');
    expect(st.branch).toBe('main');
    expect(st.upstream).toBe('origin/main');
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(1);
    expect(st.entries).toHaveLength(5);
    expect(st.entries[0]).toMatchObject({
      path: 'src/a.ts',
      index: '.',
      worktree: 'M',
      kind: 'ordinary',
    });
    expect(st.entries[1]).toMatchObject({ path: 'new file.txt', index: 'A' });
    expect(st.entries[2]).toMatchObject({ path: 'new.ts', origPath: 'old.ts', kind: 'renamed' });
    expect(st.entries[3]).toMatchObject({ path: 'untracked.md', kind: 'untracked' });
    expect(st.entries[4]).toMatchObject({ path: 'ignored.log', kind: 'ignored' });
    expect(st.dirtyCount).toBe(4);
  });

  it('treats a detached head as no branch', () => {
    const st = parsePorcelainV2('# branch.head (detached)' + NUL, '/r');
    expect(st.branch).toBeNull();
    expect(st.dirtyCount).toBe(0);
  });
});

describe('statusLetter', () => {
  it('prefers the worktree state over the index state', () => {
    expect(statusLetter({ path: 'x', index: 'A', worktree: 'M', kind: 'ordinary' })).toBe('M');
    expect(statusLetter({ path: 'x', index: 'A', worktree: '.', kind: 'ordinary' })).toBe('A');
    expect(statusLetter({ path: 'x', index: '.', worktree: '?', kind: 'untracked' })).toBe('?');
    expect(statusLetter({ path: 'x', index: 'U', worktree: 'U', kind: 'unmerged' })).toBe('U');
  });
});
