import { describe, expect, it } from 'vitest';
import { parseAuthStatus, parseRepoList, usesGhHelper } from '../src/server/github.js';

describe('usesGhHelper', () => {
  it('accepts the host-scoped entries gh auth setup-git writes', () => {
    expect(
      usesGhHelper([
        'credential.https://github.com.helper ',
        'credential.https://github.com.helper !/usr/bin/gh auth git-credential',
      ]),
    ).toBe(true);
    expect(usesGhHelper(['credential.helper !gh auth git-credential'])).toBe(true);
    expect(usesGhHelper(['credential.helper libsecret'])).toBe(false);
    expect(usesGhHelper([])).toBe(false);
  });
});

describe('parseAuthStatus', () => {
  it('reads the account from gh auth status output', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account octocat (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
    ].join('\n');
    expect(parseAuthStatus(out, 0)).toEqual({ loggedIn: true, user: 'octocat' });
  });

  it('treats a non-zero exit as signed out even if text mentions an account', () => {
    expect(parseAuthStatus('You are not logged into any GitHub hosts.', 1)).toEqual({
      loggedIn: false,
      user: null,
    });
    expect(parseAuthStatus('Logged in to github.com account x (expired)', 1).loggedIn).toBe(false);
  });
});

describe('parseRepoList', () => {
  it('parses the JSON array and ignores trailing stderr noise', () => {
    const out =
      JSON.stringify([
        {
          nameWithOwner: 'o/a',
          description: null,
          isPrivate: true,
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          nameWithOwner: 'o/b',
          description: 'B',
          isPrivate: false,
          updatedAt: '2026-02-01T00:00:00Z',
        },
        { bogus: true },
      ]) + '\nsome warning\n';
    expect(parseRepoList(out)).toEqual([
      { nameWithOwner: 'o/a', description: '', isPrivate: true, updatedAt: '2026-01-01T00:00:00Z' },
      {
        nameWithOwner: 'o/b',
        description: 'B',
        isPrivate: false,
        updatedAt: '2026-02-01T00:00:00Z',
      },
    ]);
    expect(parseRepoList('error: not logged in')).toEqual([]);
  });
});
