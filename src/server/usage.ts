/**
 * Claude usage for the panel under the folder tree. Two sources, both
 * documented by Claude Code and neither holding credentials:
 *
 * - `<cache>/usage.json`, written by `cli/statusline-tap.js` from the status
 *   line payload of whichever session last got a response;
 * - `claude auth status --json`, for the account line, asked once per launch.
 *
 * Only the one file is watched (its directory, because the tap replaces the
 * file by rename and a watch on the old inode would go quiet).
 *
 * The pure part lives in `shared/usage.ts`; this file is the disk and the process.
 */
import { execFile } from 'node:child_process';
import { watch as fsWatch, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeAccount } from '../shared/types.js';
import { parseAccount, parseUsageSample, type UsageSample } from '../shared/usage.js';

/** Name of the sample file inside the cache dir; the tap writes the same name. */
export const USAGE_FILE = 'usage.json';

/** Reads the tap's sample; `null` when there is none yet or it does not parse. */
export async function readUsage(dir: string): Promise<UsageSample | null> {
  try {
    return parseUsageSample(await readFile(path.join(dir, USAGE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Calls `onChange` (debounced) whenever the tap replaces the sample in `dir`.
 * Creates `dir` first, so the watch works before the first sample exists.
 * Returns the stop function; a failing watch degrades to no live updates.
 */
export function watchUsage(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const w = fsWatch(dir, { persistent: false }, (_event, file) => {
      if (file && String(file) !== USAGE_FILE) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 300);
    });
    w.on('error', () => undefined);
    return () => {
      if (timer) clearTimeout(timer);
      w.close();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * The signed-in account from the Claude Code CLI; `null` when `claude` is
 * missing, not signed in, or slow. On Windows the CLI may be an npm `.cmd`
 * shim, which only a shell resolves; the arguments are constants, so the
 * shell sees nothing from outside.
 */
export function readAccount(): Promise<ClaudeAccount | null> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' },
      (err, stdout) => resolve(err ? null : parseAccount(stdout)),
    );
  });
}
