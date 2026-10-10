import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { GitHubStatus } from '../../shared/types.js';
import { api, socket } from '../api.js';
import { guard, notify } from '../state.js';
import { openMenu, type MenuItem } from './ContextMenu.jsx';

/** Last known GitHub access state; `null` until the first probe returns. */
export const githubStatus = signal<GitHubStatus | null>(null);

/** Re-probes `gh`; cheap (two short processes), called on demand and after sign-in. */
export async function refreshGitHubStatus(): Promise<void> {
  const s = await guard(() => api.get<GitHubStatus>('/api/github/status'));
  if (s) githubStatus.value = s;
}

/**
 * Small header control showing whether GitHub is reachable through `gh`,
 * with the setup steps as a menu. Sign-in and credential setup run in the
 * embedded terminal, so the app never sees a token.
 */
export function GitHubChip() {
  useEffect(() => void refreshGitHubStatus(), []);
  const s = githubStatus.value;
  const label = !s
    ? 'GitHub…'
    : !s.installed
      ? 'GitHub: gh missing'
      : !s.loggedIn
        ? 'GitHub: sign in'
        : !s.gitConfigured
          ? `GitHub: ${s.user} (git not set up)`
          : `GitHub: ${s.user}`;
  const ok = Boolean(s?.loggedIn && s.gitConfigured);
  return (
    <button
      class={`chip ${ok ? 'ok' : 'warn'}`}
      title="GitHub access via the gh CLI"
      onClick={(e) => openMenu(e, menu(s))}
    >
      {label}
    </button>
  );
}

function menu(s: GitHubStatus | null): MenuItem[] {
  const items: MenuItem[] = [];
  if (s && !s.installed) {
    items.push({
      label: 'gh is not installed — copy install hint',
      onClick: () => {
        void navigator.clipboard.writeText('https://github.com/cli/cli#installation');
        notify(
          'info',
          'Copied link. Debian/Ubuntu: sudo apt install gh · Windows: winget install GitHub.cli',
        );
      },
    });
  }
  items.push(
    {
      label: s?.loggedIn
        ? `Signed in as ${s.user} — sign in again`
        : 'Sign in to GitHub (in terminal)',
      disabled: s ? !s.installed : true,
      onClick: () => socket.send({ type: 'term-run', run: { action: 'gh-login' } }),
    },
    {
      label: s?.gitConfigured ? 'git uses gh credentials ✓' : 'Use gh credentials for git (HTTPS)',
      disabled: !s?.loggedIn || s.gitConfigured,
      onClick: () => socket.send({ type: 'term-run', run: { action: 'gh-setup-git' } }),
    },
    { label: 'Re-check status', onClick: () => void refreshGitHubStatus() },
  );
  return items;
}
