import type { PreparedCommit } from '../shared/types.js';

/**
 * Problems a prepared commit will hit when sent to the terminal. The queue
 * stores paths, not content, so these are recomputed from the live status
 * every render: a file edited or stashed after preparing changes the outcome.
 *
 * @param item The prepared commit being rendered.
 * @param all The whole queue, in queue order.
 * @param changed Repo-relative paths that currently have changes (any status except ignored).
 * @returns Human-readable warnings; empty when the commit would run cleanly.
 */
export function queueWarnings(
  item: PreparedCommit,
  all: PreparedCommit[],
  changed: Set<string>,
): string[] {
  const out: string[] = [];
  const others = all.filter((o) => o.id !== item.id);

  if (item.files.length === 0) {
    if (changed.size === 0) out.push('nothing to commit: the working tree is clean');
    if (others.length > 0) {
      out.push('stages everything, including files of the other prepared commits');
    }
    return out;
  }

  const unchanged = item.files.filter((f) => !changed.has(f));
  if (unchanged.length === item.files.length) {
    out.push('nothing to commit: none of its files have changes');
  } else if (unchanged.length > 0) {
    out.push(
      `${unchanged.length} of ${item.files.length} files have no changes: ${list(unchanged)}`,
    );
  }

  const shared = new Map<string, string[]>();
  for (const o of others) {
    for (const f of o.files) {
      if (item.files.includes(f)) shared.set(f, [...(shared.get(f) ?? []), firstLine(o.message)]);
    }
  }
  if (shared.size > 0) {
    out.push(
      `${shared.size} file(s) also in another prepared commit; whichever runs first takes the current content: ${list([...shared.keys()])}`,
    );
  }
  return out;
}

function list(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown}, …` : shown;
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}
