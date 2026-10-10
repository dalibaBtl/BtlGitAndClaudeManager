import type { CommitInfo, RepoSummary } from '../shared/types.js';

/**
 * Why a history action is unavailable for a commit, or `null` when it can
 * run. Computed from the data the UI already has; the server re-checks the
 * same conditions (plus a few only git can answer) before typing anything.
 *
 * - `reset`: moves the branch back to the commit, dropping everything after
 *   it. Needs a clean tree and no pushed commit among those dropped.
 * - `checkout`: detached look at the commit. Needs a clean tree.
 * - `revert`: adds an inverse commit; always allowed here (merge commits are
 *   refused by the server).
 */
export function historyBlockers(
  commit: CommitInfo,
  status: RepoSummary | null,
  commits: CommitInfo[],
): { reset: string | null; checkout: string | null; revert: string | null } {
  const dirty = status !== null && status.dirtyCount > 0 ? 'commit or stash changes first' : null;
  const detached = status !== null && status.branch === null ? 'HEAD is detached' : null;
  const after = commits.slice(
    0,
    commits.findIndex((c) => c.sha === commit.sha),
  );
  const pushedAfter = after.some((c) => c.pushed);
  return {
    reset: commit.isHead
      ? 'already at this commit'
      : (detached ?? dirty ?? (pushedAfter ? 'newer commits are already pushed' : null)),
    checkout: commit.isHead ? 'already at this commit' : dirty,
    revert: null,
  };
}
