import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FolderNode } from '../shared/types.js';

/**
 * Directory names never descended into. They are either VCS/tool internals or
 * dependency and build output that can hold tens of thousands of directories
 * and never contain a repo the user cares about.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'target',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.npm',
  '.cargo',
  '.rustup',
  '.nuget',
  '.gradle',
  '.m2',
  'proc',
  'sys',
  'dev',
  'run',
  'snap',
  'lost+found',
  'System Volume Information',
  '$Recycle.Bin',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
]);

/** Hard cap on recursion so a pathological tree cannot run away. */
export const MAX_DEPTH = 14;

/**
 * Whether a directory entry should be skipped. Hidden directories are skipped
 * unless they are the configured root itself, because dotfolders are almost
 * always caches or tool state. Users who keep repos in a dotfolder add it as a
 * root explicitly.
 */
export function shouldSkip(name: string, depth: number): boolean {
  if (depth > 0 && name.startsWith('.')) return true;
  return SKIP_DIRS.has(name);
}

/** Callbacks the scanner reports through; batches keep message counts low. */
export interface ScanSink {
  onBatch(items: FolderNode[]): void;
  onDone(dirCount: number): void;
}

/**
 * Walks `root` breadth-first and reports every visible directory.
 *
 * Descent stops at a repo (a directory containing `.git`, file or folder),
 * because the repo tree pane shows what is inside. Repo detection is a single
 * `stat`, and directory listing uses `opendir` so large directories stream.
 * Concurrency is bounded to keep the process light even on a spinning disk.
 *
 * @param root Absolute directory to scan.
 * @param signal Aborts the walk; pending batches are still flushed.
 * @param sink Receives nodes in batches and the final count.
 */
export async function scanRoot(root: string, signal: AbortSignal, sink: ScanSink): Promise<void> {
  const BATCH = 200;
  const CONCURRENCY = 8;
  let batch: FolderNode[] = [];
  let dirCount = 0;
  const queue: { dir: string; depth: number; parent: string | null }[] = [
    { dir: root, depth: 0, parent: null },
  ];

  const flush = () => {
    if (batch.length > 0) {
      sink.onBatch(batch);
      batch = [];
    }
  };

  const visit = async (item: { dir: string; depth: number; parent: string | null }) => {
    if (signal.aborted) return;
    const isRepo = await exists(path.join(item.dir, '.git'));
    const children: string[] = [];
    if (!isRepo && item.depth < MAX_DEPTH) {
      try {
        const dir = await opendir(item.dir);
        for await (const ent of dir) {
          if (signal.aborted) break;
          if (!ent.isDirectory()) continue;
          if (shouldSkip(ent.name, item.depth + 1)) continue;
          children.push(path.join(item.dir, ent.name));
        }
      } catch {
        // Permission denied or vanished mid-scan: report the node without children.
      }
    }
    dirCount++;
    batch.push({
      path: item.dir,
      parent: item.parent,
      name: item.parent === null ? item.dir : path.basename(item.dir),
      isRepo,
      hasChildren: children.length > 0,
    });
    if (batch.length >= BATCH) flush();
    for (const c of children) queue.push({ dir: c, depth: item.depth + 1, parent: item.dir });
  };

  let active = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!signal.aborted) {
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      active++;
      try {
        await visit(item);
      } finally {
        active--;
      }
    }
  });
  await Promise.all(workers);
  flush();
  sink.onDone(dirCount);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Lists immediate subdirectories of `dir` for the folder picker, hidden ones included. */
export async function listSubdirs(dir: string): Promise<string[]> {
  const result: string[] = [];
  const d = await opendir(dir);
  for await (const ent of d) {
    if (ent.isDirectory()) result.push(ent.name);
  }
  return result.sort((a, b) => a.localeCompare(b));
}
