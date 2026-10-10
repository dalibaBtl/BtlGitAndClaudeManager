import { signal } from '@preact/signals';
import { api, socket } from '../api.js';
import { joinNative } from '../../shared/paths.js';
import type { ClaudeSession, FolderNode, GitHubRepo, RepoSummary } from '../../shared/types.js';
import { UNPLACED_ROOT, treeNodes, type TreeMode, type TreeNode } from '../state.js';
import {
  childrenOf,
  config,
  dirtyOnly,
  guard,
  hasDirtyDescendant,
  notify,
  scanning,
  selectRepo,
  selectedRepo,
  hasRepoDescendant,
  hasSessionDescendant,
  sessionsByFolder,
  treeMode,
  summaries,
} from '../state.js';
import { openMenu, type MenuItem } from './ContextMenu.jsx';
import { askConfirm, askFolder, askPick, askText } from './Dialogs.jsx';
import { githubStatus } from './GitHubChip.jsx';

const expanded = signal<Set<string>>(new Set());

/**
 * Colour state of a repo, in priority order: uncommitted work first, then
 * commits not yet pushed, then whether there is an upstream to compare with.
 * Being behind the upstream is shown as a marker, not a colour, because it
 * needs no local action beyond a pull.
 */
export type RepoState = 'dirty' | 'ahead' | 'local' | 'synced';

export function repoState(s: RepoSummary): RepoState {
  if (s.dirtyCount > 0) return 'dirty';
  if (s.ahead > 0) return 'ahead';
  if (!s.upstream) return 'local';
  return 'synced';
}

const STATE_LABEL: Record<RepoState, string> = {
  dirty: 'uncommitted changes',
  ahead: 'committed, not pushed',
  local: 'no upstream (nothing to push to)',
  synced: 'in sync with upstream',
};

function toggle(p: string): void {
  const next = new Set(expanded.value);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  expanded.value = next;
}

/** Left pane: configured roots, their folders down to repo level, and Claude sessions. */
export function FolderTree() {
  const roots = config.value.roots;
  const addRoot = () =>
    guard(async () => {
      const dir = await askFolder('Add folder', roots[0] ?? '');
      if (!dir) return;
      const looksLikeDrive = /^([A-Za-z]:\\?|\/)$/.test(dir) || /^\/(home|mnt|media)\/?$/.test(dir);
      if (looksLikeDrive) {
        const ok = await askConfirm(
          'Scan a whole drive?',
          `${dir} is very large. Scanning it will take a while and use memory for every folder found. Continue?`,
          'Scan anyway',
        );
        if (!ok) return;
      }
      await api.post('/api/roots', { path: dir });
    });

  return (
    <section class="pane folder-pane">
      <header>
        <span class="title">Folders</span>
        <select
          class="mode"
          title="What to show"
          value={treeMode.value}
          onChange={(e) => (treeMode.value = (e.target as HTMLSelectElement).value as TreeMode)}
        >
          <option value="both">git + claude</option>
          <option value="git">git only</option>
          <option value="claude">claude only</option>
        </select>
        <label class={`check ${treeMode.value === 'claude' ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            disabled={treeMode.value === 'claude'}
            checked={dirtyOnly.value}
            onChange={(e) => (dirtyOnly.value = (e.target as HTMLInputElement).checked)}
          />
          dirty only
        </label>
        <button
          title="Rescan folders and sessions"
          onClick={() => guard(() => api.post('/api/refresh', {}))}
        >
          ↻
        </button>
        <button class="primary" title="Add a folder to scan" onClick={addRoot}>
          + Add
        </button>
      </header>
      <div class="tree">
        {roots.length === 0 && (
          <p class="empty">Add a folder to start scanning for repositories.</p>
        )}
        {roots.map((r) => (
          <FolderRow key={r} path={r} depth={0} />
        ))}
        {treeMode.value !== 'git' && treeNodes.value.has(UNPLACED_ROOT) && (
          <FolderRow path={UNPLACED_ROOT} depth={0} />
        )}
      </div>
      <footer class="legend">
        <span class="dirty">■ uncommitted</span>
        <span class="ahead">■ unpushed</span>
        <span class="synced">■ synced</span>
        <span class="local">■ no upstream</span>
      </footer>
    </section>
  );
}

function FolderRow({ path, depth }: { path: string; depth: number }) {
  const node = childrenOf.value.get(null)?.find((n) => n.path === path) ?? rootPlaceholder(path);
  return <NodeRow node={node} depth={depth} />;
}

function rootPlaceholder(path: string): FolderNode {
  return { path, parent: null, name: path, isRepo: false, hasChildren: false };
}

function NodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const hidden = config.value.hidden.includes(node.path);
  if (hidden) return null;
  const mode = treeMode.value;
  // Roots always stay visible so the user can see what is being scanned.
  if (depth > 0) {
    if (mode === 'git' && !hasRepoDescendant.value.has(node.path)) return null;
    if (mode === 'claude' && !hasSessionDescendant.value.has(node.path)) return null;
    if (mode !== 'claude' && dirtyOnly.value && !hasDirtyDescendant.value.has(node.path))
      return null;
  }

  const kids = childrenOf.value.get(node.path) ?? [];
  const nodeSessions = mode === 'git' ? [] : (sessionsByFolder.value.get(node.path) ?? []);
  const summary = summaries.value.get(node.path);
  const open =
    expanded.value.has(node.path) || (depth === 0 && !expanded.value.has(`!${node.path}`));
  const expandable = kids.length > 0 || nodeSessions.length > 0;
  const isSelected = selectedRepo.value === node.path;
  const scan = node.parent === null ? scanning.value.get(node.path) : undefined;

  const onToggle = () => {
    if (depth === 0) {
      // Roots default to open; a hidden `!` marker records an explicit collapse.
      const next = new Set(expanded.value);
      const key = `!${node.path}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      expanded.value = next;
    } else {
      toggle(node.path);
    }
  };

  const state = summary ? repoState(summary) : '';
  const stateTitle = summary
    ? `${node.path}\n${STATE_LABEL[state as RepoState]}`
    : node.ghost
      ? `${node.path}\nFolder not found on disk; shown only to place its Claude sessions.`
      : node.path;

  return (
    <>
      <div
        class={`row ${node.isRepo ? 'repo' : 'folder'} ${isSelected ? 'selected' : ''} ${state} ${
          node.ghost ? 'ghost' : ''
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => (node.isRepo ? void selectRepo(node.path) : onToggle())}
        onDblClick={() => node.isRepo && onToggle()}
        onContextMenu={(e) => openMenu(e, folderMenu(node))}
        title={stateTitle}
      >
        <span
          class={`caret ${expandable ? '' : 'blank'}`}
          onClick={(e) => (e.stopPropagation(), onToggle())}
        >
          {expandable ? (open ? '▾' : '▸') : ''}
        </span>
        <span class="name">{node.name}</span>
        {node.ghost && <span class="meta ghost-tag">missing</span>}
        {summary && (
          <span class="meta">
            {summary.branch ?? 'detached'}
            {summary.ahead > 0 && <i class="ahead"> ↑{summary.ahead}</i>}
            {summary.behind > 0 && <i class="behind"> ↓{summary.behind}</i>}
            {summary.dirtyCount > 0 && <b> ({summary.dirtyCount})</b>}
          </span>
        )}
        {scan !== undefined && <span class="meta scanning">scanning…</span>}
      </div>
      {open && (
        <>
          {nodeSessions.map((s) => (
            <SessionRow key={s.id} session={s} depth={depth + 1} />
          ))}
          {kids.map((k) => (
            <NodeRow key={k.path} node={k} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

/** A Claude Code session row, shown in Claude's orange. */
export function SessionRow({ session, depth }: { session: ClaudeSession; depth: number }) {
  const when = new Date(session.modified).toLocaleString();
  return (
    <div
      class="row session"
      style={{ paddingLeft: `${depth * 14 + 6}px` }}
      title={`${session.id}\n${when}\n${session.file}`}
      onContextMenu={(e) => openMenu(e, sessionMenu(session))}
      onDblClick={() => socket.send({ type: 'term-run', run: { action: 'resume', session } })}
    >
      <span class="caret blank" />
      <span class="badge">◆</span>
      <span class="name">{session.label}</span>
      <span class="meta">{relativeTime(session.modified)}</span>
    </div>
  );
}

export function sessionMenu(session: ClaudeSession): MenuItem[] {
  return [
    {
      label: 'Resume in terminal',
      onClick: () => socket.send({ type: 'term-run', run: { action: 'resume', session } }),
    },
    {
      label: 'Resume in external terminal',
      onClick: () => guard(() => api.post('/api/sessions/resume-external', { id: session.id })),
    },
    {
      label: 'Open folder in external terminal',
      onClick: () => guard(() => api.post('/api/open', { target: session.cwd, kind: 'terminal' })),
    },
    {
      label: 'Copy resume command',
      onClick: () => {
        void navigator.clipboard.writeText(`cd '${session.cwd}' && claude --resume ${session.id}`);
        notify('info', 'Copied');
      },
    },
    {
      label: 'Delete session…',
      danger: true,
      onClick: () =>
        guard(async () => {
          const ok = await askConfirm(
            'Delete Claude session',
            `Delete the transcript "${session.label}"? It will no longer be resumable.`,
            'Delete',
          );
          if (ok) await api.del('/api/sessions', { id: session.id });
        }),
    },
  ];
}

function folderMenu(node: TreeNode): MenuItem[] {
  const items: MenuItem[] = [];
  if (node.path === UNPLACED_ROOT) return [];
  if (node.ghost) {
    // Nothing on disk to open or initialise; only the path itself is useful.
    return [
      {
        label: 'Copy path',
        onClick: () => {
          void navigator.clipboard.writeText(node.path);
          notify('info', 'Copied');
        },
      },
    ];
  }
  items.push({
    label: 'New Claude session here',
    onClick: () => socket.send({ type: 'term-run', run: { action: 'claude', dir: node.path } }),
  });
  if (node.isRepo) {
    items.push({
      label: 'Open in terminal',
      onClick: () => socket.send({ type: 'term-run', run: { action: 'cd', dir: node.path } }),
    });
  } else {
    items.push(
      {
        label: 'Init git here',
        onClick: () =>
          guard(async () => {
            const ok = await askConfirm(
              'Initialise repository',
              `git init in ${node.path}?`,
              'Init',
            );
            if (ok) await api.post('/api/repo/init', { dir: node.path });
          }),
      },
      {
        label: 'New repo in subfolder…',
        onClick: () =>
          guard(async () => {
            const name = await askText('New repository', `Folder name inside ${node.path}`, {
              okLabel: 'Create',
            });
            if (name?.trim())
              await api.post('/api/repo/init', { dir: joinNative(node.path, name.trim()) });
          }),
      },
      {
        label: 'Clone from GitHub…',
        disabled: !githubStatus.value?.loggedIn,
        onClick: () =>
          guard(async () => {
            const repo = await askPick<string>(
              'Clone from GitHub',
              'Search your repositories…',
              async () => {
                const r = await api.get<{ repos: GitHubRepo[] }>('/api/github/repos');
                return r.repos.map((it) => ({
                  label: it.nameWithOwner,
                  detail: `${it.isPrivate ? 'private' : 'public'}${it.description ? ' · ' + it.description : ''}`,
                  value: it.nameWithOwner,
                }));
              },
            );
            if (repo)
              socket.send({ type: 'term-run', run: { action: 'gh-clone', dir: node.path, repo } });
          }),
      },
      {
        label: 'Clone from URL…',
        onClick: () =>
          guard(async () => {
            const url = await askText('Clone repository', `git clone <url> into ${node.path}`, {
              okLabel: 'Clone',
            });
            if (url)
              socket.send({ type: 'term-run', run: { action: 'clone', dir: node.path, url } });
          }),
      },
    );
  }
  items.push(
    {
      label: 'Open in file manager',
      onClick: () => guard(() => api.post('/api/open', { target: node.path, kind: 'default' })),
    },
    {
      label: 'Open in external terminal',
      onClick: () => guard(() => api.post('/api/open', { target: node.path, kind: 'terminal' })),
    },
  );
  if (node.parent === null) {
    items.push({
      label: 'Remove folder from list',
      danger: true,
      onClick: () => guard(() => api.del('/api/roots', { path: node.path })),
    });
  } else {
    items.push({
      label: 'Hide folder',
      onClick: () => guard(() => api.post('/api/hidden', { path: node.path, hidden: true })),
    });
  }
  return items;
}

/** Short relative time such as `3h` or `2d`; sessions older than a month show the date. */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d}d`;
  return new Date(ms).toLocaleDateString();
}
