import { execFile } from 'node:child_process';
import type { GitHubRepo, GitHubStatus } from '../shared/types.js';
import { onPath } from './external.js';

/**
 * Thin wrapper over the `gh` CLI. The app never holds GitHub credentials:
 * `gh auth login` (device flow in the browser) stores the token, and
 * `gh auth setup-git` makes git use it over HTTPS. Everything here is
 * read-only; sign-in and clone run in the embedded terminal.
 */

/** Name of the gh executable on this platform. */
export function ghBinary(): string {
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

function run(args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      ghBinary(),
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** Current GitHub access state; never throws. */
export async function status(): Promise<GitHubStatus> {
  if (!onPath(ghBinary())) {
    return { installed: false, loggedIn: false, user: null, gitConfigured: false };
  }
  const [auth, helper] = await Promise.all([
    run(['auth', 'status', '--hostname', 'github.com']),
    gitCredentialHelpers(),
  ]);
  const parsed = parseAuthStatus(auth.out, auth.code);
  return { installed: true, ...parsed, gitConfigured: usesGhHelper(helper) };
}

/**
 * Whether any credential helper entry routes through `gh`. `gh auth setup-git`
 * writes host-scoped keys (`credential.https://github.com.helper`), so the
 * lines come from `git config --get-regexp`, not from `credential.helper`.
 */
export function usesGhHelper(configLines: string[]): boolean {
  return configLines.some((line) => /^credential\..*helper\s+.*gh auth git-credential/.test(line));
}

/**
 * Extracts login state from `gh auth status` output, which is text meant for
 * humans; the account line looks like `Logged in to github.com account NAME (…)`.
 */
export function parseAuthStatus(
  out: string,
  code: number,
): { loggedIn: boolean; user: string | null } {
  const m = /Logged in to github\.com (?:account|as) ([\w.-]+)/i.exec(out);
  if (code === 0 && m) return { loggedIn: true, user: m[1] ?? null };
  return { loggedIn: false, user: null };
}

/** Repositories the signed-in user can see: their own plus those of their organisations. */
export async function listRepos(): Promise<GitHubRepo[]> {
  if (!onPath(ghBinary())) throw new Error('gh is not installed');
  const fields = 'nameWithOwner,description,isPrivate,updatedAt';
  const own = await run(['repo', 'list', '--limit', '300', '--json', fields]);
  if (own.code !== 0) throw new Error(own.out.trim() || 'gh repo list failed; are you signed in?');
  const repos = parseRepoList(own.out);
  const orgs = await run(['api', 'user/orgs', '--jq', '.[].login']);
  if (orgs.code === 0) {
    const names = orgs.out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[\w.-]+$/.test(s));
    for (const org of names) {
      const r = await run(['repo', 'list', org, '--limit', '300', '--json', fields]);
      if (r.code === 0) repos.push(...parseRepoList(r.out));
    }
  }
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Parses `gh … --json` output; tolerates the trailing stderr our runner appends. */
export function parseRepoList(out: string): GitHubRepo[] {
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  const raw = JSON.parse(out.slice(start, end + 1)) as Partial<GitHubRepo>[];
  return raw
    .filter((r) => typeof r.nameWithOwner === 'string')
    .map((r) => ({
      nameWithOwner: r.nameWithOwner as string,
      description: typeof r.description === 'string' ? r.description : '',
      isPrivate: Boolean(r.isPrivate),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    }));
}

function gitCredentialHelpers(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['config', '--global', '--get-regexp', '^credential\\..*helper$'],
      { encoding: 'utf8' },
      (_err, stdout) =>
        resolve(
          String(stdout ?? '')
            .split('\n')
            .filter(Boolean),
        ),
    );
  });
}
