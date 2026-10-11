/**
 * Wire types shared by the server and the browser front-end.
 *
 * Everything crossing the HTTP/WebSocket boundary is declared here so both
 * sides compile against one contract. Paths are always absolute, native
 * (platform-specific separators) and untouched by the UI; the UI only ever
 * echoes them back.
 */

/** A directory discovered by the folder scanner. */
export interface FolderNode {
  path: string;
  /** Parent directory path, or `null` for a configured root. */
  parent: string | null;
  name: string;
  isRepo: boolean;
  /** Whether the scanner found at least one visible subdirectory. */
  hasChildren: boolean;
}

/** Summary of a repo's working-tree state, cheap enough to refresh for many repos at once. */
export interface RepoSummary {
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  /** Paths with unresolved conflicts. */
  conflicts: number;
  /** A multi-step git operation that was started and not finished. */
  operation: GitOperation | null;
  /** When HEAD is detached: the branch checked out before, if git remembers one. */
  previousBranch?: string | null;
}

/** Git operations that leave state in `.git` until continued or aborted. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** Status of a single path from `git status --porcelain=v2`. */
export interface StatusEntry {
  path: string;
  /** Previous path for renames and copies. */
  origPath?: string;
  /** Index (staged) status letter as git prints it, `.` when unchanged. */
  index: string;
  /** Worktree (unstaged) status letter, `.` when unchanged. */
  worktree: string;
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
}

/** Full status of one repo: summary plus per-path entries. */
export interface RepoStatus extends RepoSummary {
  entries: StatusEntry[];
}

/** One tracked or untracked file as listed for the repo tree. */
export interface RepoFile {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  status?: StatusEntry;
  ignored: boolean;
}

/** A Claude Code session found on disk. */
export interface ClaudeSession {
  id: string;
  /** Working directory the session ran in, taken from the records, not the folder name. */
  cwd: string;
  /** Path to the `.jsonl` transcript. */
  file: string;
  /** Last modification time in epoch milliseconds. */
  modified: number;
  /** Short human-readable label: the stored summary or the first user message. */
  label: string;
}

/** A commit in the history strip. */
export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  /** Epoch seconds. */
  time: number;
  subject: string;
  /** Full commit message including the subject line. */
  message: string;
  /** Whether this is the current HEAD, the only commit `--amend` can rewrite. */
  isHead: boolean;
  /** Reachable from the upstream branch. `false` when there is no upstream. */
  pushed: boolean;
  /** Files touched, with their one-letter name-status. */
  files: { status: string; path: string; origPath?: string }[];
}

/**
 * A commit that has been prepared but not yet executed.
 *
 * Stored as `<repo>/.bgcm/prepared/<id>.json`. This is a public contract: other
 * tools (notably Claude Code) write these files to queue commits for the user
 * to review and send to the terminal. `version` is bumped on incompatible changes.
 */
export interface PreparedCommit {
  version: 1;
  id: string;
  message: string;
  /** Repo-relative paths to stage. An empty list means "stage everything". */
  files: string[];
  /** Free-form origin marker, e.g. `"claude"` or `"bgcm"`. */
  createdBy: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** One parsed line of a unified diff. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** One hunk of a unified diff. */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** A parsed diff for one file. */
export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

/** Persisted user configuration. */
export interface AppConfig {
  roots: string[];
  hidden: string[];
}

/** Messages pushed from server to client over the WebSocket. */
export type ServerMessage =
  | { type: 'config'; config: AppConfig }
  | { type: 'folders'; items: FolderNode[] }
  | { type: 'folders-removed'; root: string }
  | { type: 'scan-state'; root: string; scanning: boolean; dirs: number }
  | { type: 'repo-summary'; items: RepoSummary[] }
  | { type: 'sessions'; items: ClaudeSession[] }
  | { type: 'repo-changed'; path: string }
  | { type: 'prepared'; repo: string; items: PreparedCommit[] }
  | { type: 'term-data'; data: string }
  | { type: 'term-exit'; code: number }
  | { type: 'notice'; level: 'info' | 'error'; text: string };

/**
 * Actions that are typed into the client's terminal rather than executed by
 * the server, because they may prompt (credentials, hooks, editors) or are
 * long-running and the user should see them.
 */
export type TerminalAction =
  | { action: 'cd'; dir: string }
  | { action: 'push'; repo: string }
  | { action: 'pull'; repo: string; mode: PullMode }
  | { action: 'clone'; dir: string; url: string }
  | { action: 'gh-clone'; dir: string; repo: string }
  | { action: 'publish'; repo: string; name: string; visibility: 'private' | 'public' }
  | { action: 'gh-login' }
  | { action: 'gh-setup-git' }
  | { action: 'operation'; repo: string; op: GitOperation; step: 'continue' | 'abort' }
  | { action: 'reset'; repo: string; sha: string }
  | { action: 'revert'; repo: string; sha: string }
  | { action: 'checkout'; repo: string; sha: string }
  | { action: 'switch-back'; repo: string }
  | { action: 'branch-here'; repo: string; name: string }
  | { action: 'reword'; repo: string; sha: string; message: string }
  | { action: 'commit'; repo: string; id: string };

/**
 * How a pull integrates upstream changes. `ff-only` is the default because it
 * can never leave the repo in a merge state; the other two are offered only
 * when the branches have diverged.
 */
export type PullMode = 'ff-only' | 'rebase' | 'merge';

/** What the `gh` CLI reports about GitHub access on this machine. */
export interface GitHubStatus {
  /** `gh` is on `PATH`. */
  installed: boolean;
  /** `gh auth status` succeeded for github.com. */
  loggedIn: boolean;
  /** Account name when logged in. */
  user: string | null;
  /** git's credential helper is wired to `gh` (`gh auth setup-git`). */
  gitConfigured: boolean;
}

/** A repository as listed by `gh repo list`. */
export interface GitHubRepo {
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  /** ISO-8601. */
  updatedAt: string;
}

/** Messages sent from client to server over the WebSocket. */
export type ClientMessage =
  | { type: 'term-open'; cwd: string; cols: number; rows: number }
  | { type: 'term-input'; data: string }
  | { type: 'term-resize'; cols: number; rows: number }
  | { type: 'term-run'; run: TerminalAction }
  | { type: 'watch'; repo: string | null };
