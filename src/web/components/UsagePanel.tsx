import { useEffect, useState } from 'preact/hooks';
import type { UsageState, UsageWindow } from '../../shared/types.js';
import { span, windowView } from '../../shared/usage.js';
import { api } from '../api.js';
import { guard, usage, usageCollapsed } from '../state.js';
import { askConfirm } from './Dialogs.jsx';

/** How often the relative times ("Resets in 39m", "as of 2m ago") are recomputed. */
const TICK_MS = 30_000;

/**
 * Claude subscription usage under the folder tree, in the shape of the VS Code
 * extension's panel: account, then the 5-hour and 7-day windows with a bar and
 * the time to reset. The numbers are whatever the last Claude Code session on
 * this machine reported through the status line tap, so the panel always says
 * how old they are; use elsewhere (claude.ai, another machine) shows up only
 * after the next response here. Connecting the tap, and noticing that it has
 * stopped reporting, happens here too.
 */
export function UsagePanel() {
  const now = useNow(TICK_MS);
  const u = usage.value;
  if (!u) return null;
  const collapsed = usageCollapsed.value;
  return (
    <section class="usage">
      <header onClick={() => (usageCollapsed.value = !collapsed)}>
        <span class="caret">{collapsed ? '▸' : '▾'}</span>
        <span class="title">Claude usage</span>
        {collapsed && <span class="summary">{summary(u, now)}</span>}
      </header>
      {!collapsed && <UsageBody u={u} now={now} />}
    </section>
  );
}

function UsageBody({ u, now }: { u: UsageState; now: number }) {
  const hasWindows = u.fiveHour !== null || u.sevenDay !== null;
  return (
    <div class="usage-body">
      {u.account && (
        <div class="account" title="claude auth status">
          {u.account.email ?? 'signed in'}
          {u.account.plan && <span class="plan">{u.account.plan}</span>}
        </div>
      )}
      {u.fiveHour && <UsageRow label="Session (5h)" w={u.fiveHour} now={now} />}
      {u.sevenDay && <UsageRow label="Weekly (7 day)" w={u.sevenDay} now={now} />}
      <TapNote u={u} hasWindows={hasWindows} />
      {u.seenAt !== null && (
        <div class="age">
          <span title={new Date(u.seenAt).toLocaleString()}>as of {ago(now - u.seenAt)}</span>
          {u.tap === 'connected' && (
            <button class="link" title="Restore the status line from before" onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The one line about the tap itself, when there is something to say or do. */
function TapNote({ u, hasWindows }: { u: UsageState; hasWindows: boolean }) {
  if (u.tap === 'unreadable') {
    return <p class="hint warn">~/.claude/settings.json does not parse; bgcm leaves it alone.</p>;
  }
  if (u.tap === 'disconnected') {
    return (
      <p class="hint">
        {hasWindows ? 'The status line is no longer connected. ' : ''}
        Connect Claude Code's status line so sessions report usage here.
        <button class="primary" onClick={() => void connect(u)}>
          Connect
        </button>
      </p>
    );
  }
  if (u.silent) {
    return (
      <p class="hint warn">
        Sessions were active but the status line has not reported. Sessions started before
        connecting, or another status line setup, do not report.
      </p>
    );
  }
  if (u.seenAt === null) return <p class="hint">Waiting for the next Claude Code response.</p>;
  if (!hasWindows) {
    return <p class="hint">Claude Code reports no limits for this sign-in (Pro and Max only).</p>;
  }
  return null;
}

async function connect(u: UsageState): Promise<void> {
  const ok = await askConfirm(
    'Connect the status line',
    `bgcm sets statusLine in ~/.claude/settings.json to\n\n${u.tapCommand}\n\n` +
      (u.statusLine
        ? `Your current status line\n\n${u.statusLine}\n\nkeeps showing: the tap runs it after recording the numbers. `
        : 'There is no status line now; the tap shows the two percentages. ') +
      'Disconnect puts the old setting back.',
    'Connect',
  );
  if (ok) await guard(() => api.post('/api/usage/connect', {}));
}

function disconnect(): void {
  void guard(() => api.post('/api/usage/disconnect', {}));
}

function UsageRow({ label, w, now }: { label: string; w: UsageWindow; now: number }) {
  const v = windowView(w, now);
  const level = v.percent >= 90 ? 'high' : v.percent >= 75 ? 'mid' : '';
  return (
    <div class={`usage-row ${v.expired ? 'expired' : ''}`}>
      <div class="line">
        <span>{label}</span>
        <span class="pct">{v.percent}%</span>
      </div>
      <div class="bar">
        <div class={`fill ${level}`} style={{ width: `${v.percent}%` }} />
      </div>
      <div class="resets" title={new Date(w.resetsAt * 1000).toLocaleString()}>
        {v.resets}
      </div>
    </div>
  );
}

/** One line for the folded header: the two percentages, or nothing without a sample. */
function summary(u: UsageState, now: number): string {
  const parts = [
    u.fiveHour && `5h ${windowView(u.fiveHour, now).percent}%`,
    u.sevenDay && `7d ${windowView(u.sevenDay, now).percent}%`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function ago(ms: number): string {
  return ms < 60_000 ? 'just now' : `${span(ms)} ago`;
}

/** Current time in epoch ms, re-rendering the caller every `interval` ms. */
function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}
