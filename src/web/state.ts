import { computed, signal } from '@preact/signals';
import { isWithin } from '../shared/paths.js';
import type {
  AppConfig,
  ClaudeSession,
  CommitInfo,
  FolderNode,
  PreparedCommit,
  RepoFile,
  RepoSummary,
  ServerMessage,
  UpdateState,
} from '../shared/types.js';
import { api, socket } from './api.js';

/**
 * Application state as Preact signals. Server-pushed collections are kept in
 * plain Maps inside signals and replaced wholesale on change; the trees are
 * small enough that recomputing derived views is cheaper than fine-grained updates.
 */

export const config = signal<AppConfig>({ roots: [], hidden: [] });
export const folders = signal<Map<string, FolderNode>>(new Map());
export const summaries = signal<Map<string, RepoSummary>>(new Map());
export const sessions = signal<ClaudeSession[]>([]);
export const scanning = signal<Map<string, number>>(new Map());

export const selectedRepo = signal<string | null>(null);
export const repoFiles = signal<RepoFile[]>([]);
export const repoStatus = signal<RepoSummary | null>(null);
export const prepared = signal<PreparedCommit[]>([]);
export const commits = signal<CommitInfo[]>([]);

/** `null` selects the working tree; a sha selects that commit's column. */
export const selectedCommit = signal<string | null>(null);
export const selectedFile = signal<string | null>(null);
export const diffText = signal<string>('');
export const diffLoading = signal(false);
export const fullFile = signal(false);

/** Whether the diff pane is slid away to the right edge. Persisted per browser profile. */
export const diffCollapsed = signal(readFlag('bgcm.diffCollapsed'));
diffCollapsed.subscribe((v) => writeFlag('bgcm.diffCollapsed', v));

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    // storage unavailable: the flag lives for this page only
  }
}

export const dirtyOnly = signal(false);
export const changedOnly = signal(false);
export const hideIgnored = signal(true);
export const checkedFiles = signal<Set<string>>(new Set());

export interface Notice {
  id: number;
  level: 'info' | 'error';
  text: string;
}
/** Where this installation stands against the repository; `null` until the first check. */
export const update = signal<UpdateState | null>(null);
/** A newer build is on disk than the one the server runs; a restart picks it up. */
export const updateBuilt = signal(false);

export const notices = signal<Notice[]>([]);
let noticeSeq = 0;

/** Shows a transient message in the corner; errors stay longer. */
export function notify(level: Notice['level'], text: string): void {
  const id = ++noticeSeq;
  notices.value = [...notices.value, { id, level, text }];
  setTimeout(
    () => {
      notices.value = notices.value.filter((n) => n.id !== id);
    },
    level === 'error' ? 8000 : 3500,
  );
}

/** Runs an async action and reports failures as notices instead of unhandled rejections. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    notify('error', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/**
 * A node of the folder tree. `ghost` marks a folder that does not exist on
 * disk (or was never scanned) but is needed to place a Claude session whose
 * cwd points there, e.g. sessions copied from another machine or whose folder
 * was deleted. Ghosts carry no repo state and no file-system actions.
 */
export type TreeNode = FolderNode & { ghost?: boolean };

/**
 * Synthetic root that collects sessions whose cwd lies under none of the
 * configured roots (another machine, another user name, another OS). The
 * `bgcm:` scheme cannot collide with a real path on any platform.
 */
export const UNPLACED_ROOT = 'bgcm:unplaced';

/**
 * Scanned folders plus ghost folders for every session cwd that is not itself
 * scanned: inside a repo, deleted, or foreign. A cwd under a scanned root gets
 * ghosts down from its nearest scanned ancestor; any other cwd gets its whole
 * path as ghosts under {@link UNPLACED_ROOT}, which exists only while needed.
 */
export const treeNodes = computed(() => {
  const map = new Map<string, TreeNode>(folders.value);
  for (const s of sessions.value) {
    if (map.has(s.cwd)) continue;
    const missing: string[] = [];
    let p: string | null = s.cwd;
    while (p && !map.has(p)) {
      missing.push(p);
      p = parentPath(p);
    }
    const anchor = p ?? ensureUnplacedRoot(map);
    for (const path of missing.reverse()) {
      const parent = parentPath(path) ?? anchor;
      map.set(path, {
        path,
        parent,
        name: parent === anchor && p === null ? path : path.slice(parent.length + 1),
        isRepo: false,
        hasChildren: false,
        ghost: true,
      });
    }
  }
  return map;
});

function ensureUnplacedRoot(map: Map<string, TreeNode>): string {
  if (!map.has(UNPLACED_ROOT)) {
    map.set(UNPLACED_ROOT, {
      path: UNPLACED_ROOT,
      parent: null,
      name: 'Sessions from unknown paths',
      isRepo: false,
      hasChildren: true,
      ghost: true,
    });
  }
  return UNPLACED_ROOT;
}

/** Children lookup for the folder tree, rebuilt when folders or ghosts change. */
export const childrenOf = computed(() => {
  const map = new Map<string | null, TreeNode[]>();
  for (const n of treeNodes.value.values()) {
    const list = map.get(n.parent) ?? [];
    list.push(n);
    map.set(n.parent, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
});

/** What the folder tree shows: repos, Claude sessions, or both. Persisted per browser profile. */
export type TreeMode = 'git' | 'claude' | 'both';
export const treeMode = signal<TreeMode>(readMode());
treeMode.subscribe((v) => {
  try {
    localStorage.setItem('bgcm.treeMode', v);
  } catch {
    // storage unavailable: the mode lives for this page only
  }
});

function readMode(): TreeMode {
  try {
    const v = localStorage.getItem('bgcm.treeMode');
    return v === 'git' || v === 'claude' ? v : 'both';
  } catch {
    return 'both';
  }
}

/** Sessions keyed by their cwd, which after {@link treeNodes} is always a tree node or unreachable. */
export const sessionsByFolder = computed(() => {
  const map = new Map<string, ClaudeSession[]>();
  const known = treeNodes.value;
  for (const s of sessions.value) {
    if (!known.has(s.cwd)) continue;
    const list = map.get(s.cwd) ?? [];
    list.push(s);
    map.set(s.cwd, list);
  }
  return map;
});

/** Parent of a native path, or `null` at the root. Works for both separators. */
function parentPath(p: string): string | null {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i <= 0) return null;
  return p.slice(0, i);
}

/** Marks a folder and all its ancestors in `set`. */
function markAncestors(set: Set<string>, start: string): void {
  let p: string | null = start;
  while (p) {
    set.add(p);
    p = treeNodes.value.get(p)?.parent ?? null;
  }
}

/** Whether a folder subtree contains a dirty repo, for the "dirty only" filter. */
export const hasDirtyDescendant = computed(() => {
  const set = new Set<string>();
  for (const s of summaries.value.values()) if (s.dirtyCount > 0) markAncestors(set, s.path);
  return set;
});

/** Whether a folder subtree contains a repo, for the "git" tree mode. */
export const hasRepoDescendant = computed(() => {
  const set = new Set<string>();
  for (const n of folders.value.values()) if (n.isRepo) markAncestors(set, n.path);
  return set;
});

/** Whether a folder subtree contains a Claude session, for the "claude" tree mode. */
export const hasSessionDescendant = computed(() => {
  const set = new Set<string>();
  for (const p of sessionsByFolder.value.keys()) markAncestors(set, p);
  return set;
});

// ---- actions -----------------------------------------------------------------

/** Selects a repo and loads its files, status, queue and history. */
export async function selectRepo(repo: string | null): Promise<void> {
  selectedRepo.value = repo;
  selectedCommit.value = null;
  selectedFile.value = null;
  diffText.value = '';
  checkedFiles.value = new Set();
  socket.send({ type: 'watch', repo });
  if (!repo) {
    repoFiles.value = [];
    repoStatus.value = null;
    prepared.value = [];
    commits.value = [];
    return;
  }
  await reloadRepo();
}

/** Re-fetches the selected repo's files and history, e.g. after a change notification. */
export async function reloadRepo(): Promise<void> {
  const repo = selectedRepo.value;
  if (!repo) return;
  await guard(async () => {
    const [r, l] = await Promise.all([
      api.get<{ files: RepoFile[]; status: RepoSummary; prepared: PreparedCommit[] }>(
        '/api/repo/files',
        {
          repo,
          ignored: hideIgnored.value ? '0' : '1',
        },
      ),
      api.get<{ commits: CommitInfo[] }>('/api/repo/log', { repo, n: '40' }),
    ]);
    if (selectedRepo.value !== repo) return;
    repoFiles.value = r.files;
    repoStatus.value = r.status;
    prepared.value = r.prepared;
    commits.value = l.commits;
    const present = new Set(r.files.map((f) => f.path));
    checkedFiles.value = new Set([...checkedFiles.value].filter((p) => present.has(p)));
  });
  if (selectedFile.value) await loadDiff();
}

/** Selects a file in the working tree or in a commit column, loads its diff and reveals the pane. */
export async function selectFile(file: string, sha: string | null): Promise<void> {
  selectedFile.value = file;
  selectedCommit.value = sha;
  diffCollapsed.value = false;
  await loadDiff();
}

export async function loadDiff(): Promise<void> {
  const repo = selectedRepo.value;
  const file = selectedFile.value;
  if (!repo || !file) return;
  diffLoading.value = true;
  const query: Record<string, string> = { repo, file, full: fullFile.value ? '1' : '0' };
  if (selectedCommit.value) query.sha = selectedCommit.value;
  const res = await guard(() => api.get<{ text: string }>('/api/repo/diff', query));
  diffLoading.value = false;
  if (res && selectedFile.value === file) diffText.value = res.text;
}

/** Applies a server message to the state. */
export function applyServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'config':
      config.value = msg.config;
      break;
    case 'folders': {
      const next = new Map(folders.value);
      for (const n of msg.items) next.set(n.path, n);
      folders.value = next;
      break;
    }
    case 'folders-removed': {
      const next = new Map<string, FolderNode>();
      for (const [p, n] of folders.value) if (!isWithin(msg.root, p)) next.set(p, n);
      folders.value = next;
      if (selectedRepo.value && isWithin(msg.root, selectedRepo.value)) void selectRepo(null);
      break;
    }
    case 'scan-state': {
      const next = new Map(scanning.value);
      if (msg.scanning) next.set(msg.root, msg.dirs);
      else next.delete(msg.root);
      scanning.value = next;
      break;
    }
    case 'repo-summary': {
      const next = new Map(summaries.value);
      for (const s of msg.items) next.set(s.path, s);
      summaries.value = next;
      if (selectedRepo.value && next.has(selectedRepo.value)) {
        repoStatus.value = next.get(selectedRepo.value) ?? null;
      }
      break;
    }
    case 'sessions':
      sessions.value = msg.items;
      break;
    case 'repo-changed':
      if (msg.path === selectedRepo.value) void reloadRepo();
      break;
    case 'prepared':
      if (msg.repo === selectedRepo.value) prepared.value = msg.items;
      break;
    case 'update':
      update.value = msg.state;
      updateBuilt.value = msg.built;
      break;
    case 'notice':
      notify(msg.level, msg.text);
      break;
    case 'term-data':
    case 'term-exit':
      // Handled by the terminal component.
      break;
  }
}
