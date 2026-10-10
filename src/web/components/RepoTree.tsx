import { signal } from '@preact/signals';
import { statusLetter } from '../../shared/porcelain.js';
import { joinNative } from '../../shared/paths.js';
import type { CommitInfo, RepoFile } from '../../shared/types.js';
import { api, socket } from '../api.js';
import {
  changedOnly,
  checkedFiles,
  commits,
  guard,
  hideIgnored,
  notify,
  reloadRepo,
  repoFiles,
  repoStatus,
  selectFile,
  selectedCommit,
  selectedFile,
  selectedRepo,
} from '../state.js';
import { openMenu, type MenuItem } from './ContextMenu.jsx';
import { askConfirm, askText } from './Dialogs.jsx';
import { relativeTime } from './FolderTree.jsx';
import { PreparedQueue } from './PreparedQueue.jsx';

/** A node of the file tree built from flat repo-relative paths. */
interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: RepoFile;
  /** Aggregate status letter for folders; the file's own letter for files. */
  letter: string;
  ignored: boolean;
}

/** Collapsed folders per column, keyed by `${column}:${path}`. Folders default to open. */
const collapsed = signal<Set<string>>(new Set());

function buildTree(
  files: { path: string; file?: RepoFile; letter: string; ignored: boolean }[],
): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), letter: '', ignored: false };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? '';
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: acc, children: new Map(), letter: '', ignored: true };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.file = f.file;
        child.letter = f.letter;
        child.ignored = f.ignored;
      }
      if (!f.ignored) child.ignored = false;
      if (f.letter && !f.ignored && i < parts.length - 1 && child.letter !== 'U') {
        child.letter = f.letter === '?' && child.letter ? child.letter : 'M';
      }
      node = child;
    }
  }
  return root;
}

function sortedChildren(n: TreeNode): TreeNode[] {
  return [...n.children.values()].sort((a, b) => {
    const da = a.children.size > 0 ? 0 : 1;
    const db = b.children.size > 0 ? 0 : 1;
    return da - db || a.name.localeCompare(b.name);
  });
}

/** Middle pane: working-tree column followed by one column per recent commit. */
export function RepoTree() {
  const repo = selectedRepo.value;
  if (!repo) {
    return (
      <section class="pane repo-pane">
        <header>
          <span class="title">Repository</span>
        </header>
        <p class="empty">Select a repository on the left.</p>
      </section>
    );
  }
  return (
    <section class="pane repo-pane">
      <header>
        <span class="title" title={repo}>
          {repo.split(/[\\/]/).pop()}
        </span>
        <span class="meta">
          {repoStatus.value?.branch ?? ''}
          {repoStatus.value && repoStatus.value.ahead > 0 && ` ↑${repoStatus.value.ahead}`}
          {repoStatus.value && repoStatus.value.behind > 0 && ` ↓${repoStatus.value.behind}`}
        </span>
        <label class="check">
          <input
            type="checkbox"
            checked={changedOnly.value}
            onChange={(e) => (changedOnly.value = (e.target as HTMLInputElement).checked)}
          />
          changed only
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={hideIgnored.value}
            onChange={(e) => {
              hideIgnored.value = (e.target as HTMLInputElement).checked;
              void reloadRepo();
            }}
          />
          hide ignored
        </label>
        <button onClick={() => socket.send({ type: 'term-run', run: { action: 'pull', repo } })}>
          Pull
        </button>
        <button onClick={() => socket.send({ type: 'term-run', run: { action: 'push', repo } })}>
          Push
        </button>
        <button
          onClick={() =>
            guard(async () => {
              if (
                !(await askConfirm(
                  'Stash all',
                  'Stash every change including untracked files?',
                  'Stash',
                ))
              )
                return;
              const r = await api.post<{ output: string }>('/api/repo/stash', { repo, files: [] });
              notify('info', r.output || 'Stashed');
            })
          }
        >
          Stash all
        </button>
      </header>
      <div class="columns">
        <WorkingTreeColumn repo={repo} />
        {commits.value.map((c) => (
          <CommitColumn key={c.sha} repo={repo} commit={c} />
        ))}
      </div>
    </section>
  );
}

function WorkingTreeColumn({ repo }: { repo: string }) {
  const files = repoFiles.value
    .filter((f) => !(hideIgnored.value && f.ignored))
    .filter((f) => !changedOnly.value || (f.status && f.status.kind !== 'ignored'))
    .map((f) => ({
      path: f.path,
      file: f,
      letter: f.status ? statusLetter(f.status) : '',
      ignored: f.ignored,
    }));
  const tree = buildTree(files);
  const dirty = repoStatus.value?.dirtyCount ?? 0;
  return (
    <div class="column working">
      <div class="column-head">
        <b>Working tree</b>
        <span class="meta">{dirty > 0 ? `${dirty} changed` : 'clean'}</span>
      </div>
      <PreparedQueue repo={repo} />
      <div class="tree">
        {sortedChildren(tree).map((n) => (
          <FileRow key={n.path} repo={repo} node={n} depth={0} column="wt" sha={null} />
        ))}
        {files.length === 0 && <p class="empty">Nothing to show.</p>}
      </div>
    </div>
  );
}

function CommitColumn({ repo, commit }: { repo: string; commit: CommitInfo }) {
  const tree = buildTree(
    commit.files.map((f) => ({ path: f.path, letter: f.status, ignored: false })),
  );
  const active = selectedCommit.value === commit.sha;
  const when = new Date(commit.time * 1000).toLocaleString();
  const where = commit.pushed ? 'pushed' : 'not pushed';
  return (
    <div class={`column commit ${active ? 'active' : ''} ${commit.pushed ? '' : 'unpushed'}`}>
      <div
        class="column-head"
        title={`${commit.sha}\n${commit.author}\n${when}\n${where}\n\n${commit.message}`}
        onContextMenu={(e) => openMenu(e, commitMenu(repo, commit))}
      >
        <b>
          {!commit.pushed && (
            <i class="unpushed-mark" title="Not pushed">
              ↑{' '}
            </i>
          )}
          {commit.subject}
        </b>
        <span class="meta">
          {commit.shortSha} · {commit.author} · {relativeTime(commit.time * 1000)}
        </span>
      </div>
      <div class="tree">
        {sortedChildren(tree).map((n) => (
          <FileRow
            key={n.path}
            repo={repo}
            node={n}
            depth={0}
            column={commit.sha}
            sha={commit.sha}
          />
        ))}
      </div>
    </div>
  );
}

function FileRow({
  repo,
  node,
  depth,
  column,
  sha,
}: {
  repo: string;
  node: TreeNode;
  depth: number;
  column: string;
  sha: string | null;
}) {
  const isDir = node.children.size > 0;
  const key = `${column}:${node.path}`;
  const open = !collapsed.value.has(key);
  const isSelected = selectedFile.value === node.path && selectedCommit.value === sha;
  const checkable = sha === null && !isDir && node.letter !== '' && node.letter !== '!';

  const toggle = () => {
    const next = new Set(collapsed.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed.value = next;
  };

  return (
    <>
      <div
        class={`row file st-${node.letter || 'clean'} ${node.ignored ? 'ignored' : ''} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => (isDir ? toggle() : void selectFile(node.path, sha))}
        onContextMenu={(e) => openMenu(e, fileMenu(repo, node, sha))}
        title={node.path}
      >
        <span class={`caret ${isDir ? '' : 'blank'}`}>{isDir ? (open ? '▾' : '▸') : ''}</span>
        {checkable && (
          <input
            type="checkbox"
            class="pick"
            checked={checkedFiles.value.has(node.path)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const next = new Set(checkedFiles.value);
              if ((e.target as HTMLInputElement).checked) next.add(node.path);
              else next.delete(node.path);
              checkedFiles.value = next;
            }}
          />
        )}
        <span class="name">{node.name}</span>
        {node.letter && <span class="letter">{node.letter}</span>}
      </div>
      {open && isDir && (
        <>
          {sortedChildren(node).map((c) => (
            <FileRow
              key={c.path}
              repo={repo}
              node={c}
              depth={depth + 1}
              column={column}
              sha={sha}
            />
          ))}
        </>
      )}
    </>
  );
}

/**
 * Context menu of a commit column. Reword is offered only where `--amend` is
 * safe: the commit is HEAD and the upstream does not have it yet. The server
 * re-checks both before typing anything into the terminal.
 */
function commitMenu(repo: string, commit: CommitInfo): MenuItem[] {
  const blocker = !commit.isHead
    ? 'only the latest commit can be reworded'
    : commit.pushed
      ? 'already pushed'
      : null;
  return [
    {
      label: blocker ? `Reword… (${blocker})` : 'Reword…',
      disabled: blocker !== null,
      onClick: () =>
        guard(async () => {
          const message = await askText('Reword commit', `New message for ${commit.shortSha}`, {
            multiline: true,
            initial: commit.message,
            okLabel: 'Amend',
          });
          if (!message || message.trim() === commit.message.trim()) return;
          socket.send({
            type: 'term-run',
            run: { action: 'reword', repo, sha: commit.sha, message },
          });
        }),
    },
    {
      label: 'Copy SHA',
      onClick: () => {
        void navigator.clipboard.writeText(commit.sha);
        notify('info', 'Copied');
      },
    },
  ];
}

function fileMenu(repo: string, node: TreeNode, sha: string | null): MenuItem[] {
  const abs = joinNative(repo, node.path);
  const items: MenuItem[] = [];
  if (sha === null) {
    items.push(
      {
        label: node.children.size > 0 ? 'Stash folder changes' : 'Stash file',
        disabled: !node.letter,
        onClick: () =>
          guard(async () => {
            const r = await api.post<{ output: string }>('/api/repo/stash', {
              repo,
              files: [node.path],
            });
            notify('info', r.output || 'Stashed');
          }),
      },
      {
        label: 'Ignore (add to .gitignore and untrack)',
        onClick: () =>
          guard(async () => {
            const ok = await askConfirm(
              'Ignore path',
              `Add /${node.path} to .gitignore and remove it from the index? Files stay on disk.`,
              'Ignore',
            );
            if (ok) await api.post('/api/repo/ignore', { repo, pattern: node.path });
          }),
      },
    );
  }
  items.push({
    label: 'Open in external app',
    onClick: () => guard(() => api.post('/api/open', { target: abs, kind: 'default' })),
  });
  if (node.children.size > 0) {
    items.push({
      label: 'Open in external terminal',
      onClick: () => guard(() => api.post('/api/open', { target: abs, kind: 'terminal' })),
    });
  }
  items.push({
    label: 'Copy path',
    onClick: () => {
      void navigator.clipboard.writeText(abs);
      notify('info', 'Copied');
    },
  });
  return items;
}
