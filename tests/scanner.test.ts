import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRoot, shouldSkip } from '../src/server/scanner.js';
import type { FolderNode } from '../src/shared/types.js';

describe('shouldSkip', () => {
  it('skips dependency and build folders and hidden folders below the root', () => {
    expect(shouldSkip('node_modules', 1)).toBe(true);
    expect(shouldSkip('bin', 3)).toBe(true);
    expect(shouldSkip('.config', 1)).toBe(true);
    expect(shouldSkip('.config', 0)).toBe(false);
    expect(shouldSkip('src', 1)).toBe(false);
  });
});

describe('scanRoot', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bgcm-scan-'));
    await mkdir(path.join(root, 'work', 'repoA', '.git'), { recursive: true });
    await mkdir(path.join(root, 'work', 'repoA', 'nested', 'deeper'), { recursive: true });
    await mkdir(path.join(root, 'work', 'plain', 'sub'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, 'worktree'), { recursive: true });
    // A `.git` *file* marks a linked worktree or submodule and counts as a repo.
    await writeFile(path.join(root, 'worktree', '.git'), 'gitdir: /elsewhere\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('reports folders, marks repos and stops descending inside them', async () => {
    const nodes: FolderNode[] = [];
    let total = 0;
    await scanRoot(root, new AbortController().signal, {
      onBatch: (items) => nodes.push(...items),
      onDone: (n) => (total = n),
    });
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    expect(total).toBe(nodes.length);
    expect(byPath.get(root)).toMatchObject({ parent: null, isRepo: false, hasChildren: true });
    expect(byPath.get(path.join(root, 'work', 'repoA'))).toMatchObject({
      isRepo: true,
      hasChildren: false,
    });
    expect(byPath.get(path.join(root, 'worktree'))?.isRepo).toBe(true);
    expect(byPath.get(path.join(root, 'work', 'plain', 'sub'))).toMatchObject({ isRepo: false });
    expect(byPath.has(path.join(root, 'work', 'repoA', 'nested'))).toBe(false);
    expect(byPath.has(path.join(root, 'node_modules'))).toBe(false);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const nodes: FolderNode[] = [];
    await scanRoot(root, ctrl.signal, {
      onBatch: (i) => nodes.push(...i),
      onDone: () => undefined,
    });
    expect(nodes.length).toBe(0);
  });
});
