/**
 * Self-update: where this clone stands against `origin/main`, and bringing it
 * there. `bgcm update --check` is what the server runs hourly; `bgcm update`
 * is typed into the terminal by the **Update** chip, so every step and every
 * error is in view. No root is involved: the clone belongs to the user.
 *
 * The pure part lives in `shared/update.ts`; this file is the processes.
 */
import { execFile, spawn } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateState } from '../shared/types.js';
import { describeUpdate, updateState } from '../shared/update.js';

/** Upper bound for `git fetch`; GitHub normally answers in a second or two. */
const FETCH_TIMEOUT_MS = 30_000;

/** Root of this clone, resolved from the built server bundle in `dist/`. */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Reads where the clone at `root` stands; never throws, a failing git shows up as fields. */
export async function checkUpdate(root: string): Promise<UpdateState> {
  const fetched = (await git(root, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS)) !== null;
  const [head, branch, upstream, status, behind, log] = await Promise.all([
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
    git(root, ['rev-list', '--count', 'HEAD..origin/main']),
    git(root, ['log', '--format=%s', 'HEAD..origin/main']),
  ]);
  return updateState(await packageVersion(root), {
    head,
    branch,
    upstream,
    status,
    behind,
    log,
    fetched,
  });
}

/**
 * The update itself. Refuses a clone that is not a plain tracking checkout,
 * because `pull --ff-only` would either fail noisily or, on a developer's
 * machine, be the wrong thing to do at all. Each step is echoed before it
 * runs and its output stays in the terminal.
 */
export async function runUpdate(root: string): Promise<number> {
  const state = await checkUpdate(root);
  process.stdout.write(`${describeUpdate(state)}\n`);
  if (state.blocked === 'dirty' || state.blocked === 'detached') {
    process.stderr.write('bgcm: this clone is not updated automatically; use git in it yourself\n');
    return 2;
  }
  if (state.blocked === 'offline') {
    process.stderr.write('bgcm: could not reach the repository; try again later\n');
    return 1;
  }
  if (state.behind === 0) {
    process.stdout.write('nothing to update\n');
    return 0;
  }
  for (const [cmd, args] of [
    ['git', ['pull', '--ff-only']],
    ['npm', ['ci', '--no-audit', '--no-fund']],
    ['npm', ['run', 'build']],
  ] as const) {
    const code = await visible(root, cmd, [...args]);
    if (code !== 0) {
      process.stderr.write(`bgcm: ${cmd} ${args.join(' ')} failed with code ${code}\n`);
      return 1;
    }
  }
  const after = await checkUpdate(root);
  process.stdout.write(
    `now at ${after.commit}; press Restart in the app, or start it again from the launcher\n`,
  );
  return 0;
}

/** Prints the check in the CLI's text or JSON form. */
export async function printCheck(root: string, json: boolean): Promise<number> {
  const state = await checkUpdate(root);
  process.stdout.write(json ? `${JSON.stringify(state)}\n` : `${describeUpdate(state)}\n`);
  if (!json && state.subjects.length > 0) {
    process.stdout.write(state.subjects.map((s) => `  ${s}\n`).join(''));
  }
  return 0;
}

/**
 * Watches the built server bundle. `npm run build` (by hand or through
 * `bgcm update`) replaces `dist/server.js` while the old code keeps running;
 * the server tells its windows a restart is worth it instead of restarting on
 * its own, because a restart ends the terminal's shell.
 */
export function watchDist(distDir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  try {
    const w = fsWatch(distDir, { persistent: false }, (_event, file) => {
      if (file && !/^server\.js$/.test(String(file))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 2000);
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

async function packageVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One git read in `root`; `null` on any failure so the caller can degrade. */
function git(root: string, args: string[], timeout = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: root, encoding: 'utf8', timeout, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** Runs a step with the terminal as its stdio, echoing the line first. */
function visible(root: string, cmd: string, args: string[]): Promise<number> {
  process.stdout.write(`+ ${[cmd, ...args].join(' ')}\n`);
  return new Promise((resolve) => {
    // npm is a .cmd on Windows; a shell resolves it the same way the user's prompt would.
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (e) => {
      process.stderr.write(`${cmd}: ${e.message}\n`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
