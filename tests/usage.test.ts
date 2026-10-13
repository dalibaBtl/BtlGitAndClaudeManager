import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SILENT_AFTER_MS,
  isSilent,
  parseAccount,
  parseUsageSample,
  span,
  windowView,
} from '../src/shared/usage.js';

const limits = {
  five_hour: { used_percentage: 18.4, resets_at: 1_000_000 },
  seven_day: { used_percentage: 42, resets_at: 2_000_000 },
};

describe('parseUsageSample', () => {
  it('reads both windows and both times from the tap file', () => {
    expect(parseUsageSample(JSON.stringify({ seen: 7, at: 5, rate_limits: limits }))).toEqual({
      at: 5,
      seen: 7,
      fiveHour: { usedPercentage: 18.4, resetsAt: 1_000_000 },
      sevenDay: { usedPercentage: 42, resetsAt: 2_000_000 },
    });
  });

  it('drops a malformed window, clamps the percentage, rejects a file without `seen`', () => {
    const s = parseUsageSample(
      JSON.stringify({
        seen: 5,
        at: null,
        rate_limits: {
          five_hour: { used_percentage: '18' },
          seven_day: { used_percentage: 130, resets_at: 9 },
        },
      }),
    );
    expect(s?.at).toBeNull();
    expect(s?.fiveHour).toBeNull();
    expect(s?.sevenDay).toEqual({ usedPercentage: 100, resetsAt: 9 });
    expect(parseUsageSample(JSON.stringify({ at: 5, rate_limits: limits }))).toBeNull();
    expect(parseUsageSample('not json')).toBeNull();
  });
});

describe('parseAccount', () => {
  it('takes email and plan from a signed-in status, nothing otherwise', () => {
    expect(
      parseAccount(JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' })),
    ).toEqual({ email: 'a@b.c', plan: 'max' });
    expect(parseAccount(JSON.stringify({ loggedIn: false, email: 'a@b.c' }))).toBeNull();
    expect(parseAccount('')).toBeNull();
  });
});

describe('windowView', () => {
  it('shows the percentage and time left, and 0 % once the window has reset', () => {
    const w = { usedPercentage: 17.6, resetsAt: 10_000 };
    expect(windowView(w, 10_000_000 - 39 * 60_000)).toEqual({
      percent: 18,
      resets: 'Resets in 39m',
      expired: false,
    });
    expect(windowView(w, 10_000_000)).toEqual({ percent: 0, resets: 'Reset', expired: true });
  });

  it('formats spans at the scale that matters', () => {
    expect(span(45_000)).toBe('45s');
    expect(span(39 * 60_000)).toBe('39m');
    expect(span(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
    expect(span(5 * 3_600_000)).toBe('5h');
    expect(span(53 * 3_600_000)).toBe('2d 5h');
  });
});

describe('isSilent', () => {
  it('fires only when sessions were active well after both the last report and connecting', () => {
    const t = 100 * SILENT_AFTER_MS;
    expect(isSilent(null, null, 0)).toBe(false);
    expect(isSilent(t, t - 1000, 0)).toBe(false);
    expect(isSilent(t, t - SILENT_AFTER_MS - 1, 0)).toBe(true);
    expect(isSilent(t, null, t - 1000)).toBe(false);
    expect(isSilent(t, null, 0)).toBe(true);
  });
});

describe('statusline-tap', () => {
  const tap = fileURLToPath(new URL('../cli/statusline-tap.js', import.meta.url));
  const scratch = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bgcm-tap-'));
    return {
      root,
      file: path.join(root, 'cache', 'bgcm', 'usage.json'),
      link: path.join(root, 'config', 'bgcm', 'statusline.json'),
    };
  };
  const run = (root: string, payload: unknown, ...args: string[]) =>
    spawnSync(process.execPath, [tap, ...args], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        LOCALAPPDATA: path.join(root, 'cache'),
        APPDATA: path.join(root, 'config'),
      },
    });

  it('records limits, keeps them across payloads without any, and prints a summary', () => {
    const { root, file } = scratch();
    let r = run(root, { model: { id: 'x' }, rate_limits: limits });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('5h 18% · 7d 42%');
    const first = parseUsageSample(readFileSync(file, 'utf8'));
    expect(first?.fiveHour?.usedPercentage).toBe(18.4);
    expect(first?.at).toBe(first?.seen);

    // Unchanged numbers within the heartbeat: no rewrite.
    run(root, { rate_limits: limits });
    expect(parseUsageSample(readFileSync(file, 'utf8'))).toEqual(first);

    // A payload without limits (new session) never erases the last ones.
    writeFileSync(file, JSON.stringify({ seen: 1, at: 1, rate_limits: limits }));
    r = run(root, { model: { id: 'x' } });
    const kept = parseUsageSample(readFileSync(file, 'utf8'));
    expect(kept?.at).toBe(1);
    expect(kept?.seen).toBeGreaterThan(1);
    expect(kept?.fiveHour?.usedPercentage).toBe(18.4);
    expect(r.stdout).toBe('5h 18% · 7d 42%');

    expect(run(root, 'garbage').status).toBe(0);
  });

  it('runs the replaced status line with the same payload and passes its output through', () => {
    const { root, link } = scratch();
    mkdirSync(path.dirname(link), { recursive: true });
    const echo = `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`;
    writeFileSync(
      link,
      JSON.stringify({ version: 1, previous: { type: 'command', command: echo }, connectedAt: 0 }),
    );
    const payload = JSON.stringify({ rate_limits: limits });
    const r = run(root, payload);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(payload);
    expect(run(root, payload, '--quiet').stdout).toBe('');
  });

  it('records only the heartbeat for a first payload without limits', () => {
    const { root, file } = scratch();
    run(root, { model: { id: 'x' } });
    expect(existsSync(file)).toBe(true);
    const s = parseUsageSample(readFileSync(file, 'utf8'));
    expect(s?.at).toBeNull();
    expect(s?.fiveHour).toBeNull();
  });
});
