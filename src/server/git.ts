import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePorcelainV2 } from '../shared/porcelain.js';
import type {
  CommitInfo,
  RepoFile,
  RepoStatus,
  RepoSummary,
  StatusEntry,
} from '../shared/types.js';

/** Error raised when git exits non-zero; `stderr` carries git's own explanation. */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
  }
}

/**
 * Runs `git` with the given arguments in `cwd` and returns stdout.
 *
 * All read operations go through here. Operations that may prompt (push, pull,
 * commit with hooks, clone over SSH) are deliberately *not* run this way; they
 * are typed into the embedded terminal so the user sees and answers prompts.
 *
 * @throws GitError when git exits non-zero or cannot be started.
 */
export function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        if (code !== null && okCodes.includes(code)) {
          resolve(stdout);
        } else {
          reject(
            new GitError(`git ${args[0]} failed: ${stderr.trim() || err?.message}`, stderr, code),
          );
        }
      },
    );
  });
}

/** Full working-tree status including ignored entries. */
export async function status(repo: string, includeIgnored: boolean): Promise<RepoStatus> {
  const args = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];
  if (includeIgnored) args.push('--ignored=matching');
  const out = await git(repo, args);
  return parsePorcelainV2(out, repo);
}

/** Cheap summary used for the folder tree's dirty counts. */
export async function summary(repo: string): Promise<RepoSummary> {
  const out = await git(repo, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  const { entries, ...rest } = parsePorcelainV2(out, repo);
  return rest;
}

/**
 * Lists every file of the repo for the tree view: tracked, untracked and
 * (optionally) ignored, each annotated with its status.
 */
export async function listFiles(repo: string, includeIgnored: boolean): Promise<RepoFile[]> {
  const [tracked, st] = await Promise.all([
    git(repo, ['ls-files', '-z']),
    status(repo, includeIgnored),
  ]);
  const byPath = new Map<string, StatusEntry>();
  for (const e of st.entries) byPath.set(e.path, e);

  const files = new Map<string, RepoFile>();
  for (const p of tracked.split('\0')) {
    if (p) files.set(p, { path: p, status: byPath.get(p), ignored: false });
  }
  for (const e of st.entries) {
    if (e.kind === 'ignored') {
      files.set(e.path, { path: e.path, status: e, ignored: true });
    } else if (!files.has(e.path)) {
      files.set(e.path, { path: e.path, status: e, ignored: false });
    }
  }
  return [...files.values()];
}

/**
 * Diff of one working-tree path against HEAD (staged and unstaged combined).
 * Untracked files are diffed against `/dev/null` so they render as all-added.
 *
 * @param context Number of context lines; a very large value yields the whole file.
 */
export async function diffWorktree(repo: string, file: string, context: number): Promise<string> {
  const tracked = await isTracked(repo, file);
  if (tracked) {
    return git(repo, ['diff', `-U${context}`, '--no-color', 'HEAD', '--', file]).catch(
      (e: GitError) => {
        // Repos without any commit have no HEAD; fall back to the index-vs-worktree diff.
        if (/bad revision|ambiguous argument/.test(e.stderr)) {
          return git(repo, ['diff', `-U${context}`, '--no-color', '--', file]);
        }
        throw e;
      },
    );
  }
  // `--no-index` exits 1 when there are differences, which is the normal case here.
  return git(
    repo,
    ['diff', `-U${context}`, '--no-color', '--no-index', '--', nullDevice(), file],
    [0, 1],
  );
}

/** Diff of one path as changed by a specific commit. */
export function diffCommit(
  repo: string,
  sha: string,
  file: string,
  context: number,
): Promise<string> {
  return git(repo, ['show', `-U${context}`, '--no-color', '--format=', sha, '--', file]);
}

/** Recent history with the files each commit touched. */
export async function log(repo: string, limit: number): Promise<CommitInfo[]> {
  let out: string;
  try {
    // Record separator 0x1e, field separator 0x1f, and 0x1d closes the free-form body
    // so the name-status lines that follow can be split off safely.
    out = await git(repo, [
      'log',
      `-n${limit}`,
      '--name-status',
      '--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%B%x1d',
    ]);
  } catch (e) {
    if (e instanceof GitError && /does not have any commits/.test(e.stderr)) return [];
    throw e;
  }
  const [head, unpushed] = await Promise.all([headSha(repo), unpushedShas(repo)]);
  return out
    .split('\x1e')
    .filter((rec) => rec.trim() !== '')
    .map((rec) => parseLogRecord(rec, head, unpushed));
}

/** Parses one `log` record; exported for tests. */
export function parseLogRecord(
  rec: string,
  head: string | null,
  unpushed: Set<string> | null,
): CommitInfo {
  const end = rec.indexOf('\x1d');
  const header = end < 0 ? rec : rec.slice(0, end);
  const rest = end < 0 ? [] : rec.slice(end + 1).split('\n');
  const [sha = '', shortSha = '', author = '', time = '0', subject = '', body = ''] =
    header.split('\x1f');
  const files: CommitInfo['files'] = [];
  for (const line of rest) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const st = parts[0] ?? '';
    if (st.startsWith('R') || st.startsWith('C')) {
      files.push({ status: st[0] ?? 'R', origPath: parts[1], path: parts[2] ?? '' });
    } else {
      files.push({ status: st, path: parts[1] ?? '' });
    }
  }
  return {
    sha,
    shortSha,
    author,
    time: Number(time),
    subject,
    message: body.replace(/\n+$/, ''),
    isHead: sha === head,
    // No upstream: nothing is pushed anywhere, so every commit counts as local.
    pushed: unpushed !== null && !unpushed.has(sha),
    files,
  };
}

/** Whether the current branch tracks an upstream. */
export async function hasUpstream(repo: string): Promise<boolean> {
  return git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .then(() => true)
    .catch(() => false);
}

/** Configured remote names. */
export async function remotes(repo: string): Promise<string[]> {
  const out = await git(repo, ['remote']);
  return out.split('\n').filter(Boolean);
}

/** Current HEAD commit, or `null` in an empty repo. */
export async function headSha(repo: string): Promise<string | null> {
  return git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
    .then((s) => s.trim() || null)
    .catch(() => null);
}

/**
 * Commits on HEAD that the upstream does not have, or `null` when the branch
 * has no upstream.
 */
export async function unpushedShas(repo: string): Promise<Set<string> | null> {
  try {
    const out = await git(repo, ['rev-list', '@{upstream}..HEAD']);
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Whether `sha` is already contained in the upstream branch. Exit 1 means
 * "not an ancestor"; exit 128 means there is no upstream, which also counts
 * as not pushed.
 */
export async function isPushed(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', sha, '@{upstream}']);
    return true;
  } catch (e) {
    if (e instanceof GitError && (e.code === 1 || e.code === 128)) return false;
    throw e;
  }
}

/** Stashes the given paths (or everything when empty), including untracked files. */
export function stash(repo: string, files: string[]): Promise<string> {
  const args = ['stash', 'push', '--include-untracked'];
  if (files.length > 0) args.push('--', ...files);
  return git(repo, args);
}

/**
 * Adds `pattern` to the repo's `.gitignore` and stops tracking anything that
 * already matches it, so the ignore takes effect for future commits without
 * deleting the files from disk.
 */
export async function ignore(repo: string, pattern: string): Promise<void> {
  const file = path.join(repo, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = '';
  }
  const line = pattern.startsWith('/') ? pattern : '/' + pattern;
  if (!existing.split(/\r?\n/).includes(line)) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${sep}${line}\n`, 'utf8');
  }
  await git(repo, ['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', pattern]);
}

/** Initialises a new repository in an existing directory. */
export async function init(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--quiet']);
}

/** Whether `file` is in the index. */
async function isTracked(repo: string, file: string): Promise<boolean> {
  const out = await git(repo, ['ls-files', '--error-unmatch', '--', file]).catch(() => '');
  return out.trim() !== '';
}

/**
 * Adds `.bgcm/` to `.git/info/exclude` so the prepared-commit queue never
 * shows up as untracked. Idempotent.
 */
export async function excludeToolDir(repo: string): Promise<void> {
  const gitDir = (await git(repo, ['rev-parse', '--git-dir'])).trim();
  const infoDir = path.resolve(repo, gitDir, 'info');
  const file = path.join(infoDir, 'exclude');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.split(/\r?\n/).includes('.bgcm/')) return;
  await mkdir(infoDir, { recursive: true });
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${sep}.bgcm/\n`, 'utf8');
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}
