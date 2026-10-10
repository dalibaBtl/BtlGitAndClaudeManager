/**
 * Path helpers that must behave identically in the browser and on the server.
 *
 * The browser has no `node:path`, and the server must not normalise user paths
 * (a Windows path must stay a Windows path), so these work on raw strings and
 * accept both separators.
 */

/** Returns the last segment of a path, or the path itself for a bare drive or `/`. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i < 0 ? p : trimmed.slice(i + 1) || p;
}

/** Joins a repo root and a repo-relative (forward-slash) path using the root's separator. */
export function joinNative(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return base + sep + rel.split('/').join(sep);
}

/** Whether `child` is `parent` itself or lies strictly inside it. */
export function isWithin(parent: string, child: string): boolean {
  const p = parent.replace(/[\\/]+$/, '');
  if (child === p) return true;
  return child.startsWith(p + '/') || child.startsWith(p + '\\');
}

/** Repo-relative forward-slash path of `abs` inside `repo`, or `null` when outside. */
export function relativeTo(repo: string, abs: string): string | null {
  if (!isWithin(repo, abs)) return null;
  const base = repo.replace(/[\\/]+$/, '');
  return abs
    .slice(base.length + 1)
    .split('\\')
    .join('/');
}
