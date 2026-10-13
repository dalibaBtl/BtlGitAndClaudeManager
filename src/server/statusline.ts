/**
 * Connecting the status line tap: the only place bgcm writes Claude Code's
 * `settings.json`, and only its `statusLine` key. Every write is
 * read-modify-write of the current file (other keys untouched, file mode kept)
 * through a temp file and a rename, so Claude Code never reads half a file. A
 * `settings.json` that does not parse is never written.
 *
 * The decisions live in `shared/statusline.ts`; this file is the disk.
 */
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  connectTap,
  disconnectTap,
  isTapStatusLine,
  parseTapLink,
  repairTap,
  type ClaudeSettings,
  type TapLink,
} from '../shared/statusline.js';
import type { TapState } from '../shared/types.js';
import { configDir } from './config.js';
import { claudeConfigDir } from './sessions.js';

/** Where the tap and bgcm keep the link; the tap computes the same path. */
export function linkFile(): string {
  return path.join(configDir(), 'statusline.json');
}

export function claudeSettingsFile(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

/** What `settings.json` holds now, plus what the panel needs to say about it. */
export interface TapStatus {
  state: TapState;
  /** The current status line command, whatever it runs; `null` when none is set. */
  command: string | null;
  link: TapLink | null;
}

export async function tapStatus(): Promise<TapStatus> {
  const link = await readLink();
  let settings: ClaudeSettings;
  try {
    settings = await readSettings();
  } catch {
    return { state: 'unreadable', command: null, link };
  }
  const s = settings.statusLine as { command?: unknown } | undefined;
  return {
    state: isTapStatusLine(settings.statusLine) ? 'connected' : 'disconnected',
    command: typeof s?.command === 'string' ? s.command : null,
    link,
  };
}

/**
 * Puts the tap in front of the current status line. The link is written
 * before `settings.json`, so a failure in between leaves the old status line
 * in place rather than a tap that has forgotten what it replaced.
 */
export async function connect(command: string): Promise<void> {
  const settings = await readSettings();
  const next = connectTap(settings, command, Date.now());
  if (!next) return;
  await mkdir(configDir(), { recursive: true });
  await writeFile(linkFile(), JSON.stringify(next.link, null, 2) + '\n', 'utf8');
  await writeSettings(next.settings);
}

/** Restores the status line from before {@link connect}, then forgets the link. */
export async function disconnect(): Promise<void> {
  const next = disconnectTap(await readSettings(), await readLink());
  if (next) await writeSettings(next);
  await rm(linkFile(), { force: true });
}

/**
 * Points a connected tap at `command` when it names another clone or node.
 * Silent and best-effort: run at every start, a missing or broken
 * `settings.json` is simply left alone. Returns whether it wrote.
 */
export async function repair(command: string): Promise<boolean> {
  try {
    const next = repairTap(await readSettings(), command);
    if (!next) return false;
    await writeSettings(next);
    return true;
  } catch {
    return false;
  }
}

async function readLink(): Promise<TapLink | null> {
  try {
    return parseTapLink(await readFile(linkFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** The settings object; `{}` when the file does not exist; throws when it does not parse. */
async function readSettings(): Promise<ClaudeSettings> {
  let text: string;
  try {
    text = await readFile(claudeSettingsFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${claudeSettingsFile()} is not a JSON object`);
  }
  return parsed as ClaudeSettings;
}

/**
 * Writes through a symlink rather than replacing it, so a `settings.json`
 * linked from a dotfiles checkout stays linked.
 */
async function writeSettings(settings: ClaudeSettings): Promise<void> {
  const file = await realpath(claudeSettingsFile()).catch(() => claudeSettingsFile());
  const mode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => 0o600,
  );
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.bgcm-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}
