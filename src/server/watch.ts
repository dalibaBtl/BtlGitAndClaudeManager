import { watch, type FSWatcher } from 'node:fs';

/**
 * Watches a single repo for changes and fires a debounced callback.
 *
 * Only the *selected* repo is watched; watching every repo under a drive-sized
 * root would exhaust inotify watches and burn CPU for folders the user is not
 * looking at. Inside `.git` only `index`, `HEAD` and `refs` matter (staging,
 * checkout, commit); object writes are ignored. Recursive `fs.watch` is used
 * where the platform supports it (Linux ≥ Node 20, macOS, Windows).
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 300,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.repo, { recursive: true, persistent: false }, (_ev, file) => {
        if (file && isNoise(String(file))) return;
        this.schedule();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }
}

/**
 * Events inside `.git` that do not change what the UI shows. Only object
 * writes, reflogs, hooks, `info/` and lock files are ignored; everything else
 * (`index`, `HEAD`, loose refs, `packed-refs` after a push or gc, `FETCH_HEAD`,
 * `MERGE_HEAD`, …) can change status, ahead/behind or an in-progress operation.
 */
export function isNoise(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts[0] !== '.git') return false;
  const inner = parts.slice(1);
  const top = inner[0] ?? '';
  if (top === 'objects' || top === 'logs' || top === 'hooks' || top === 'info') return true;
  // `index.lock` vanishing is always followed by an `index` write, so locks carry no signal.
  return (inner[inner.length - 1] ?? '').endsWith('.lock');
}
