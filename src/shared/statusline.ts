/**
 * The pure part of connecting the status line tap: what bgcm writes into
 * Claude Code's `settings.json` and what it remembers to undo it. Nothing here
 * touches the disk; `server/statusline.ts` reads and writes the files.
 *
 * Connected means `statusLine` is `{ type: 'command', command: "<node>" "<tap>" }`.
 * The user's previous `statusLine` object is kept verbatim in bgcm's own
 * config ({@link TapLink}); the tap runs its command after recording a sample,
 * and disconnecting puts the object back as it was. Keeping the previous
 * command out of `settings.json` avoids quoting one shell command inside another.
 */

/** File name of the tap; how a `statusLine.command` is recognised as bgcm's. */
export const TAP_FILE = 'statusline-tap.js';

/** What bgcm stores in `<config>/bgcm/statusline.json` while connected. */
export interface TapLink {
  version: 1;
  /** The `statusLine` value from `settings.json` before connecting; `null` when there was none. */
  previous: unknown;
  /** Epoch milliseconds of connecting: no report is expected before it. */
  connectedAt: number;
}

/** Claude Code's `settings.json`, as far as bgcm cares: an object with other keys left alone. */
export type ClaudeSettings = Record<string, unknown>;

/**
 * The status line command that runs the tap. Both paths are absolute and
 * double-quoted, which every shell Claude Code may use (sh, bash, cmd, pwsh)
 * reads as one word; a path that itself contains a quote is refused.
 */
export function tapCommand(node: string, tap: string): string {
  if (node.includes('"') || tap.includes('"')) {
    throw new Error('the node or bgcm path contains a double quote; connect the tap by hand');
  }
  return `"${node}" "${tap}"`;
}

/** Whether a `statusLine` value runs bgcm's tap (from this clone or any other). */
export function isTapStatusLine(statusLine: unknown): boolean {
  const cmd = commandOf(statusLine);
  return cmd !== null && cmd.includes(TAP_FILE);
}

/** The shell command of a `statusLine` value, or `null` when it is not a command status line. */
export function commandOf(statusLine: unknown): string | null {
  if (typeof statusLine !== 'object' || statusLine === null) return null;
  const s = statusLine as Record<string, unknown>;
  return s.type === 'command' && typeof s.command === 'string' ? s.command : null;
}

/**
 * Settings with the tap in place of the current status line, and the link
 * that remembers what was there. Other `statusLine` fields (`refreshInterval`,
 * `padding`) are kept so the line refreshes as before. Returns `null` when the
 * tap is already connected, so connecting twice never loses the original.
 */
export function connectTap(
  settings: ClaudeSettings,
  command: string,
  now: number,
): { settings: ClaudeSettings; link: TapLink } | null {
  const previous = settings.statusLine ?? null;
  if (isTapStatusLine(previous)) return null;
  const kept = typeof previous === 'object' && previous !== null ? previous : {};
  return {
    settings: { ...settings, statusLine: { ...kept, type: 'command', command } },
    link: { version: 1, previous, connectedAt: now },
  };
}

/**
 * Settings with the remembered status line back. Returns `null` when the tap
 * is not connected (someone replaced it since), so that newer choice is not
 * overwritten with an old one.
 */
export function disconnectTap(
  settings: ClaudeSettings,
  link: TapLink | null,
): ClaudeSettings | null {
  if (!isTapStatusLine(settings.statusLine)) return null;
  const next = { ...settings };
  if (link?.previous == null) delete next.statusLine;
  else next.statusLine = link.previous;
  return next;
}

/**
 * Settings with the tap's command pointed at this clone and this node, when a
 * connected tap points elsewhere (the clone moved, node was upgraded to a new
 * path). Returns `null` when there is nothing to repair.
 */
export function repairTap(settings: ClaudeSettings, command: string): ClaudeSettings | null {
  const s = settings.statusLine;
  if (!isTapStatusLine(s) || commandOf(s) === command) return null;
  return { ...settings, statusLine: { ...(s as object), command } };
}

/** Validates a stored link; anything else reads as "no link". */
export function parseTapLink(text: string): TapLink | null {
  try {
    const raw = JSON.parse(text) as Partial<TapLink>;
    if (raw?.version !== 1 || typeof raw.connectedAt !== 'number' || !('previous' in raw)) {
      return null;
    }
    return { version: 1, previous: raw.previous ?? null, connectedAt: raw.connectedAt };
  } catch {
    return null;
  }
}
