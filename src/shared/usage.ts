/**
 * The pure part of the usage panel: validating what the status line tap wrote
 * and what `claude auth status --json` printed, and turning a window into what
 * the panel shows. Shared by the server (which reads the files) and the page
 * (which renders relative times); nothing here touches a process or the disk.
 */
import type { ClaudeAccount, UsageWindow } from './types.js';

/** A validated sample from the tap file. */
export interface UsageSample {
  /** Epoch ms of the last payload that carried rate limits; `null` when none has. */
  at: number | null;
  /** Epoch ms of the last payload of any kind. */
  seen: number;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

/**
 * Parses `usage.json` as written by `cli/statusline-tap.js`:
 * `{ "seen": <epoch ms>, "at": <epoch ms> | null, "rate_limits": <the status line's rate_limits> | null }`.
 * The tap copies `rate_limits` verbatim, so this is where Claude Code's shape
 * is checked; a malformed window becomes `null` rather than failing the file.
 * Returns `null` for anything that is not JSON with a numeric `seen`.
 */
export function parseUsageSample(text: string): UsageSample | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || !isFiniteNumber(raw.seen)) return null;
  const limits = isObject(raw.rate_limits) ? raw.rate_limits : {};
  return {
    at: isFiniteNumber(raw.at) ? raw.at : null,
    seen: raw.seen,
    fiveHour: parseWindow(limits.five_hour),
    sevenDay: parseWindow(limits.seven_day),
  };
}

/**
 * How long sessions may be active without a status line report before the
 * panel calls the tap silent. Generous on purpose: the tap writes at most once
 * a minute when nothing changes, and a transcript is touched slightly before
 * the status line runs.
 */
export const SILENT_AFTER_MS = 5 * 60_000;

/**
 * Whether a connected tap has gone quiet: a session wrote its transcript well
 * after the last report and after connecting. That is what `/statusline`
 * replacing the command, or a synced `settings.json`, looks like from here.
 */
export function isSilent(
  lastSessionActivity: number | null,
  seenAt: number | null,
  connectedAt: number,
): boolean {
  if (lastSessionActivity === null) return false;
  return lastSessionActivity > Math.max(seenAt ?? 0, connectedAt) + SILENT_AFTER_MS;
}

function parseWindow(v: unknown): UsageWindow | null {
  if (!isObject(v) || !isFiniteNumber(v.used_percentage) || !isFiniteNumber(v.resets_at)) {
    return null;
  }
  return {
    usedPercentage: Math.min(100, Math.max(0, v.used_percentage)),
    resetsAt: v.resets_at,
  };
}

/**
 * Parses `claude auth status --json`. Returns `null` when the output is not
 * JSON or reports no signed-in account, so the panel shows no account line
 * instead of a wrong one.
 */
export function parseAccount(text: string): ClaudeAccount | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.loggedIn !== true) return null;
  return {
    email: typeof raw.email === 'string' ? raw.email : null,
    plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : null,
  };
}

/** What one usage row shows. */
export interface WindowView {
  /** Whole percent, 0–100. */
  percent: number;
  /** `Resets in 39m`, or `Reset` once the window has rolled over. */
  resets: string;
  /** The window rolled over after the sample: the usage shown is 0 until a session reports again. */
  expired: boolean;
}

/**
 * Turns a sampled window into the row's text at time `now` (epoch ms). A
 * window whose reset time has passed is shown as 0 %: the sample predates the
 * reset, so its percentage no longer applies.
 */
export function windowView(w: UsageWindow, now: number): WindowView {
  const left = w.resetsAt * 1000 - now;
  if (left <= 0) return { percent: 0, resets: 'Reset', expired: true };
  return {
    percent: Math.round(w.usedPercentage),
    resets: `Resets in ${span(left)}`,
    expired: false,
  };
}

/**
 * A duration in the panel's compact form, rounded down to what matters at
 * that scale: `45s`, `39m`, `4h 12m`, `2d 5h`.
 */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
