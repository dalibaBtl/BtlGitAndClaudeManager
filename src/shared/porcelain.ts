import type { RepoStatus, StatusEntry } from './types.js';

/**
 * Parses the output of `git status --porcelain=v2 --branch -z`.
 *
 * The `-z` form separates records with NUL and, for renames, puts the original
 * path in a *second* NUL-terminated field, which is why this parser walks a
 * token list instead of lines. Ignored entries appear only when the command was
 * run with `--ignored`.
 *
 * @param raw Raw stdout of the git command.
 * @param repoPath Absolute path of the repo, copied onto the result.
 * @returns Parsed status. Branch fields are `null` when git omitted them (e.g. detached HEAD).
 */
export function parsePorcelainV2(raw: string, repoPath: string): RepoStatus {
  const status: RepoStatus = {
    path: repoPath,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    conflicts: 0,
    operation: null,
    entries: [],
  };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.startsWith('# ')) {
      parseHeader(tok, status);
      continue;
    }
    const kind = tok[0];
    if (kind === '1') {
      const f = tok.split(' ');
      status.entries.push({
        path: f.slice(8).join(' '),
        index: f[1]?.[0] ?? '.',
        worktree: f[1]?.[1] ?? '.',
        kind: 'ordinary',
      });
    } else if (kind === '2') {
      const f = tok.split(' ');
      const orig = tokens[++i] ?? '';
      status.entries.push({
        path: f.slice(9).join(' '),
        origPath: orig,
        index: f[1]?.[0] ?? '.',
        worktree: f[1]?.[1] ?? '.',
        kind: 'renamed',
      });
    } else if (kind === 'u') {
      const f = tok.split(' ');
      status.entries.push({
        path: f.slice(10).join(' '),
        index: f[1]?.[0] ?? '.',
        worktree: f[1]?.[1] ?? '.',
        kind: 'unmerged',
      });
    } else if (kind === '?') {
      status.entries.push({ path: tok.slice(2), index: '.', worktree: '?', kind: 'untracked' });
    } else if (kind === '!') {
      status.entries.push({ path: tok.slice(2), index: '.', worktree: '!', kind: 'ignored' });
    }
  }
  status.dirtyCount = status.entries.filter((e) => e.kind !== 'ignored').length;
  status.conflicts = status.entries.filter((e) => e.kind === 'unmerged').length;
  return status;
}

/** Fills branch/upstream/ahead/behind from a `# branch.*` header line. */
function parseHeader(line: string, status: RepoStatus): void {
  if (line.startsWith('# branch.head ')) {
    const head = line.slice('# branch.head '.length);
    status.branch = head === '(detached)' ? null : head;
  } else if (line.startsWith('# branch.upstream ')) {
    status.upstream = line.slice('# branch.upstream '.length);
  } else if (line.startsWith('# branch.ab ')) {
    const m = /\+(\d+) -(\d+)/.exec(line);
    if (m) {
      status.ahead = Number(m[1]);
      status.behind = Number(m[2]);
    }
  }
}

/**
 * Collapses a status entry to a single letter for colouring in the tree.
 *
 * Worktree state wins over index state because it is what the user sees on
 * disk; a file that is staged and then modified again is still "modified".
 */
export function statusLetter(e: StatusEntry): string {
  if (e.kind === 'untracked') return '?';
  if (e.kind === 'ignored') return '!';
  if (e.kind === 'unmerged') return 'U';
  if (e.worktree !== '.') return e.worktree;
  return e.index;
}
