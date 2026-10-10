import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/shared/diff.js';

describe('parseUnifiedDiff', () => {
  it('parses hunks with running line numbers', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' export {};',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f?.oldPath).toBe('src/a.ts');
    expect(f?.newPath).toBe('src/a.ts');
    expect(f?.binary).toBe(false);
    const lines = f?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'add', 'context', 'meta']);
    expect(lines[0]).toMatchObject({ oldNo: 1, newNo: 1 });
    expect(lines[1]).toMatchObject({ oldNo: 2 });
    expect(lines[1]?.newNo).toBeUndefined();
    expect(lines[2]).toMatchObject({ newNo: 2 });
    expect(lines[2]?.oldNo).toBeUndefined();
    expect(lines[3]).toMatchObject({ newNo: 3 });
    expect(lines[4]).toMatchObject({ oldNo: 3, newNo: 4 });
  });

  it('handles new files diffed against /dev/null and binary files', () => {
    const text = [
      'diff --git a/x.bin b/x.bin',
      'Binary files /dev/null and b/x.bin differ',
      'diff --git a/n.txt b/n.txt',
      '--- /dev/null',
      '+++ b/n.txt',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(2);
    expect(files[0]?.binary).toBe(true);
    expect(files[1]?.oldPath).toBeNull();
    expect(files[1]?.newPath).toBe('n.txt');
    expect(files[1]?.hunks[0]?.lines[0]).toMatchObject({ kind: 'add', newNo: 1, text: 'hello' });
  });

  it('returns nothing for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
