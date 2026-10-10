import type { DiffHunk, DiffLine, FileDiff } from './types.js';

/**
 * Parses unified-diff text as produced by `git diff` / `git show` into files and hunks.
 *
 * Only the subset git emits is handled: `diff --git` headers, `---`/`+++` path
 * lines, `Binary files ... differ`, and `@@` hunks. Line numbers are computed
 * while walking hunks so the renderer never has to count. Unknown header lines
 * (`index`, `similarity index`, mode changes) are kept as `meta` lines of the
 * file but outside any hunk, which the renderer may ignore.
 *
 * @param text Raw diff output, `\n` separated.
 * @returns One entry per file in the diff; empty when the text has no `diff --git` or `@@`.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) {
      // Diff text without a `diff --git` header, e.g. `git diff --no-index` edge cases.
      file = { oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(file);
    }
    if (line.startsWith('--- ')) {
      file.oldPath = stripPathPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      file.newPath = stripPathPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('Binary files ')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = line[0];
    const text = line.slice(1);
    let dl: DiffLine;
    if (marker === '+') {
      dl = { kind: 'add', text, newNo: newNo++ };
    } else if (marker === '-') {
      dl = { kind: 'del', text, oldNo: oldNo++ };
    } else if (marker === '\\') {
      dl = { kind: 'meta', text: line };
    } else {
      dl = { kind: 'context', text, oldNo: oldNo++, newNo: newNo++ };
    }
    hunk.lines.push(dl);
  }
  return files;
}

/** Turns `a/src/x.ts` into `src/x.ts` and `/dev/null` into `null`. */
function stripPathPrefix(p: string): string | null {
  const trimmed = p.replace(/\t.*$/, '');
  if (trimmed === '/dev/null') return null;
  return trimmed.replace(/^[ab]\//, '');
}
