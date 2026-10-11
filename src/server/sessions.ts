import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudeSession } from '../shared/types.js';

/** Root of Claude Code's per-project transcript storage. */
export function claudeProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
}

/** Bytes read from the head of a transcript when looking for the id and a label. */
const HEAD_BYTES = 256 * 1024;
/**
 * Bytes read from the tail. Claude Code re-emits the user's custom title
 * (`/rename`, Ctrl+R) every few turns, so the latest one is near the end, and
 * every record carries the `cwd` the session currently runs in.
 */
const TAIL_BYTES = 256 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: ClaudeSession | null;
}

/**
 * Indexes Claude Code sessions.
 *
 * The directory name under `~/.claude/projects` is a lossy encoding of the
 * working directory (`/`, `.` and `_` all become `-`), so it is never decoded.
 * Instead the `cwd` fields inside the transcript are used. They record the
 * shell's directory at each turn, not the project: a `cd` into a subfolder
 * changes them, and a session resumed from a renamed checkout keeps the old
 * path in its early records. The one whose encoding matches the directory name
 * is therefore the project; failing that, the first one. Results
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
 * Reads the head of a transcript (id, cwd, first prompt) and, for files larger
 * than the head window, its tail (latest cwd and custom title). Returns `null`
 * when no record carries a `cwd` (e.g. an empty or foreign file).
 */
export async function readSessionHead(
  file: string,
  mtimeMs: number,
): Promise<ClaudeSession | null> {
  const fh = await open(file, 'r');
  let head: string;
  let tail: string | undefined;
  try {
    const { size } = await fh.stat();
    const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await fh.read(headBuf, 0, headBuf.length, 0);
    head = headBuf.subarray(0, bytesRead).toString('utf8');
    if (size > HEAD_BYTES) {
      const start = Math.max(HEAD_BYTES, size - TAIL_BYTES);
      const tailBuf = Buffer.alloc(size - start);
      const r = await fh.read(tailBuf, 0, tailBuf.length, start);
      // Drop the partial first line; it may be cut mid-record.
      tail = tailBuf.subarray(0, r.bytesRead).toString('utf8');
      tail = tail.slice(tail.indexOf('\n') + 1);
    }
  } finally {
    await fh.close();
  }
  return parseSessionHead(head, file, mtimeMs, tail);
}

/**
 * Pure part of session parsing, separated for tests. Tolerates a truncated last
 * line, which is the normal state of a transcript still being written. The
 * `cwd` is chosen by `pickCwd` from every value seen in the head and the tail.
 * The label is, in order of preference: the user's custom title (latest wins),
 * Claude Code's stored summary, the first user turn with text.
 */
export function parseSessionHead(
  text: string,
  file: string,
  mtimeMs: number,
  tail?: string,
): ClaudeSession | null {
  const cwds: string[] = [];
  let id: string | null = null;
  let summary: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstText: string | null = null;
  let sawImage = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec.cwd === 'string') cwds.push(rec.cwd);
    if (id === null && typeof rec.sessionId === 'string') id = rec.sessionId;
    if (summary === null && rec.type === 'summary' && typeof rec.summary === 'string') {
      summary = rec.summary;
    }
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
      customTitle = rec.customTitle;
    }
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
    // The first user turn may be an image or a bare slash command; keep looking
    // for the first turn with real text so the label says what the session was about.
    if (firstText === null && rec.type === 'user') {
      const u = extractUserText(rec);
      if (u.image) sawImage = true;
      if (u.text) firstText = u.text;
    }
  }
  if (tail) {
    const latest = latestRecords(tail);
    if (latest.cwd !== null) cwds.push(latest.cwd);
    customTitle = latest.custom ?? customTitle;
    aiTitle = latest.ai ?? aiTitle;
  }
  const cwd = pickCwd(cwds, path.basename(path.dirname(file)));
  if (!cwd) return null;
  const title = (customTitle ?? aiTitle)?.replace(/\s+/g, ' ').trim();
  const body = (summary ?? firstText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const fallback = body
    ? sawImage && !summary
      ? `(image) ${body}`
      : body
    : sawImage
      ? '(image)'
      : '';
  const label = title || fallback;
  return {
    id: id ?? path.basename(file, '.jsonl'),
    cwd,
    file,
    modified: mtimeMs,
    label: label || '(no prompt)',
  };
}

/**
 * Encodes a working directory the way Claude Code names the project folder
 * under `~/.claude/projects`: every character outside `[A-Za-z0-9-]` becomes
 * `-`. Lossy, which is why it is only ever compared, never reversed.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Picks the session's project directory from the `cwd` values seen in its
 * transcript. The folder name is the ground truth Claude Code derived from the
 * project; the first `cwd` whose encoding matches it wins. With no match (a
 * transcript moved by hand and not yet resumed from the new path) the first
 * value stands, as it did before transcripts were ever moved.
 */
export function pickCwd(cwds: readonly string[], projectDirName: string): string | null {
  return cwds.find((c) => encodeProjectDir(c) === projectDirName) ?? cwds[0] ?? null;
}

interface LatestRecords {
  cwd: string | null;
  custom: string | null;
  ai: string | null;
}

/**
 * Latest `cwd`, `custom-title` (user's rename) and `ai-title` (generated)
 * values in a chunk of transcript, scanning from the end. The titles are
 * re-emitted every few turns by Claude Code and `cwd` sits on every message
 * record, so the last occurrence of each is the current one.
 */
function latestRecords(chunk: string): LatestRecords {
  const out: LatestRecords = { cwd: null, custom: null, ai: null };
  const lines = chunk.split('\n');
  const done = () => out.cwd !== null && out.custom !== null && out.ai !== null;
  for (let i = lines.length - 1; i >= 0 && !done(); i--) {
    const line = lines[i];
    if (
      !line ||
      !(line.includes('"cwd"') || line.includes('"custom-title"') || line.includes('"ai-title"'))
    ) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        cwd?: string;
        customTitle?: string;
        aiTitle?: string;
      };
      if (out.cwd === null && typeof rec.cwd === 'string') out.cwd = rec.cwd;
      if (
        out.custom === null &&
        rec.type === 'custom-title' &&
        typeof rec.customTitle === 'string'
      ) {
        out.custom = rec.customTitle;
      }
      if (out.ai === null && rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
        out.ai = rec.aiTitle;
      }
    } catch {
      // truncated last line of a live transcript
    }
  }
  return out;
}

/**
 * Pulls plain text out of a `user` record, whose content is either a string
 * or content blocks, and notes whether it carried an image. Tool results are
 * `user` records too and are skipped, as they are not something the user typed.
 */
function extractUserText(rec: Record<string, unknown>): { text: string | null; image: boolean } {
  const msg = rec.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return { text: stripSystemTags(content) || null, image: false };
  let image = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string };
      if (b.type === 'image') image = true;
      if (b.type === 'text' && typeof b.text === 'string') {
        const cleaned = stripSystemTags(b.text);
        if (cleaned) return { text: cleaned, image };
      }
    }
  }
  return { text: null, image };
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
