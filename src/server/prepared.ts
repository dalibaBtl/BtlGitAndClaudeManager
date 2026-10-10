import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PreparedCommit } from '../shared/types.js';

/** Repo-relative directory holding the queue. Kept out of git via `.git/info/exclude`. */
export const PREPARED_DIR = path.join('.bgcm', 'prepared');

/** Lists prepared commits of a repo, oldest first. Malformed files are skipped. */
export async function listPrepared(repo: string): Promise<PreparedCommit[]> {
  const dir = path.join(repo, PREPARED_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const items: PreparedCommit[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = validatePrepared(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
      if (parsed) items.push(parsed);
    } catch {
      // A half-written file from an external tool; it will be picked up on the next change.
    }
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Writes a new prepared commit and returns it. */
export async function addPrepared(
  repo: string,
  message: string,
  files: string[],
  createdBy: string,
): Promise<PreparedCommit> {
  const dir = path.join(repo, PREPARED_DIR);
  await mkdir(dir, { recursive: true });
  const item: PreparedCommit = {
    version: 1,
    id: randomUUID(),
    message,
    files,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, `${item.id}.json`), JSON.stringify(item, null, 2) + '\n', 'utf8');
  return item;
}

/** Removes a prepared commit; missing files are not an error. */
export async function removePrepared(repo: string, id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) throw new Error('invalid prepared commit id');
  await unlink(path.join(repo, PREPARED_DIR, `${id}.json`)).catch(() => undefined);
}

/**
 * Builds the shell steps that execute a prepared commit. The message is
 * written to a temp file by the caller and referenced via `-F`, so quoting
 * only has to handle paths. The caller chains the steps in the terminal's dialect.
 */
export function commitSteps(item: PreparedCommit, messageFile: string): string[] {
  const add =
    item.files.length === 0
      ? 'git add -A'
      : `git add -A -- ${item.files.map(shellQuote).join(' ')}`;
  return [add, `git commit -F ${shellQuote(messageFile)}`];
}

/** POSIX/PowerShell-safe single quoting; both treat `'…'` literally and escape `'` by doubling. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Narrows unknown JSON to a `PreparedCommit`, returning `null` when the shape is wrong. */
export function validatePrepared(v: unknown): PreparedCommit | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (typeof o.id !== 'string' || !/^[\w-]+$/.test(o.id)) return null;
  if (typeof o.message !== 'string' || o.message.trim() === '') return null;
  if (!Array.isArray(o.files) || !o.files.every((f) => typeof f === 'string')) return null;
  return {
    version: 1,
    id: o.id,
    message: o.message,
    files: o.files as string[],
    createdBy: typeof o.createdBy === 'string' ? o.createdBy : 'unknown',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
  };
}
