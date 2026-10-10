import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudeSession } from '../shared/types.js';

/** Root of Claude Code's per-project transcript storage. */
export function claudeProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
}

/** Bytes read from the head of a transcript when looking for `cwd` and a label. */
const HEAD_BYTES = 256 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: ClaudeSession | null;
}

/**
 * Indexes Claude Code sessions.
 *
 * The directory name under `~/.claude/projects` is a lossy encoding of the
 * working directory (`/` and `_` both become `-`), so it is never decoded.
 * Instead the `cwd` field of the first record that carries one is used. Results
 * are cached per file keyed on mtime and size, so a rescan of hundreds of
 * sessions costs one `stat` each.
 */
export class SessionIndex {
  private cache = new Map<string, CacheEntry>();

  /** Scans all project directories and returns every session with a resolvable `cwd`. */
  async scan(): Promise<ClaudeSession[]> {
    const result: ClaudeSession[] = [];
    let projects;
    try {
      projects = await opendir(claudeProjectsDir());
    } catch {
      return result;
    }
    for await (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const dir = path.join(claudeProjectsDir(), proj.name);
      let files;
      try {
        files = await opendir(dir);
      } catch {
        continue;
      }
      for await (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const session = await this.load(path.join(dir, f.name));
        if (session) result.push(session);
      }
    }
    result.sort((a, b) => b.modified - a.modified);
    return result;
  }

  private async load(file: string): Promise<ClaudeSession | null> {
    let st;
    try {
      st = await stat(file);
    } catch {
      return null;
    }
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.session;
    const session = await readSessionHead(file, st.mtimeMs);
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session });
    return session;
  }
}

/**
 * Reads the first `HEAD_BYTES` of a transcript and extracts id, cwd and a label.
 * Returns `null` when no record carries a `cwd` (e.g. an empty or foreign file).
 */
export async function readSessionHead(
  file: string,
  mtimeMs: number,
): Promise<ClaudeSession | null> {
  const fh = await open(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  return parseSessionHead(text, file, mtimeMs);
}

/**
 * Pure part of session parsing, separated for tests. Tolerates a truncated last
 * line, which is the normal state of a transcript still being written.
 */
export function parseSessionHead(
  text: string,
  file: string,
  mtimeMs: number,
): ClaudeSession | null {
  let cwd: string | null = null;
  let id: string | null = null;
  let summary: string | null = null;
  let firstUser: string | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (id === null && typeof rec.sessionId === 'string') id = rec.sessionId;
    if (summary === null && rec.type === 'summary' && typeof rec.summary === 'string') {
      summary = rec.summary;
    }
    if (firstUser === null && rec.type === 'user') firstUser = extractUserText(rec) || null;
    if (cwd && id && summary) break;
  }
  if (!cwd) return null;
  const label = (summary ?? firstUser ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    id: id ?? path.basename(file, '.jsonl'),
    cwd,
    file,
    modified: mtimeMs,
    label: label || '(no prompt)',
  };
}

/** Pulls plain text out of a `user` record, whose content is either a string or content blocks. */
function extractUserText(rec: Record<string, unknown>): string | null {
  const msg = rec.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return stripSystemTags(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: string }).text;
        if (typeof t === 'string') {
          const cleaned = stripSystemTags(t);
          if (cleaned) return cleaned;
        }
      }
    }
  }
  return null;
}

/**
 * Removes harness wrappers (`<system-reminder>`, slash-command envelopes,
 * local command output) so the label shows what the user actually typed. For a
 * slash command the command name is kept, e.g. `/init`.
 */
export function stripSystemTags(text: string): string {
  return text
    .replace(/<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/g, ' $1 ')
    .replace(
      /<(system-reminder|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g,
      '',
    )
    .trim();
}
