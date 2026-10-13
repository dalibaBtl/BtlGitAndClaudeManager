import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTap,
  disconnectTap,
  isTapStatusLine,
  parseTapLink,
  repairTap,
  tapCommand,
} from '../src/shared/statusline.js';
import { connect, disconnect, repair, tapStatus } from '../src/server/statusline.js';

const TAP = '"/usr/bin/node" "/opt/bgcm/cli/statusline-tap.js"';
const MOVED = '"/usr/bin/node" "/home/me/bgcm/cli/statusline-tap.js"';
const mine = { type: 'command', command: 'bash ~/.claude/statusline.sh', refreshInterval: 10 };

describe('statusline (pure)', () => {
  it('quotes both paths and refuses a quote inside one', () => {
    expect(tapCommand('/usr/bin/node', '/opt/bgcm/cli/statusline-tap.js')).toBe(TAP);
    expect(() => tapCommand('/usr/bin/node', '/opt/"x"/statusline-tap.js')).toThrow();
  });

  it('connects in front of the old status line, keeping its fields, and only once', () => {
    const r = connectTap({ model: 'opus', statusLine: mine }, TAP, 42);
    expect(r?.settings).toEqual({
      model: 'opus',
      statusLine: { type: 'command', command: TAP, refreshInterval: 10 },
    });
    expect(r?.link).toEqual({ version: 1, previous: mine, connectedAt: 42 });
    expect(connectTap(r!.settings, TAP, 43)).toBeNull();
    expect(connectTap({}, TAP, 1)?.link.previous).toBeNull();
  });

  it('disconnects back to exactly what was there, but not over a newer choice', () => {
    const link = { version: 1 as const, previous: mine, connectedAt: 0 };
    expect(disconnectTap({ statusLine: { type: 'command', command: TAP } }, link)).toEqual({
      statusLine: mine,
    });
    expect(
      disconnectTap(
        { a: 1, statusLine: { type: 'command', command: TAP } },
        {
          ...link,
          previous: null,
        },
      ),
    ).toEqual({ a: 1 });
    expect(disconnectTap({ statusLine: mine }, link)).toBeNull();
  });

  it('repairs a tap that points at another clone and leaves everything else', () => {
    expect(repairTap({ statusLine: { type: 'command', command: MOVED, padding: 0 } }, TAP)).toEqual(
      { statusLine: { type: 'command', command: TAP, padding: 0 } },
    );
    expect(repairTap({ statusLine: { type: 'command', command: TAP } }, TAP)).toBeNull();
    expect(repairTap({ statusLine: mine }, TAP)).toBeNull();
    expect(isTapStatusLine({ type: 'static', command: TAP })).toBe(false);
  });

  it('accepts only a well-formed link', () => {
    expect(parseTapLink('{"version":1,"previous":null,"connectedAt":5}')).toEqual({
      version: 1,
      previous: null,
      connectedAt: 5,
    });
    expect(parseTapLink('{"version":2,"previous":null,"connectedAt":5}')).toBeNull();
    expect(parseTapLink('{"version":1,"connectedAt":5}')).toBeNull();
    expect(parseTapLink('nope')).toBeNull();
  });
});

describe('statusline (files)', () => {
  const saved = { ...process.env };
  let claudeDir: string;
  let settingsFile: string;

  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'bgcm-sl-'));
    claudeDir = path.join(root, 'claude');
    mkdirSync(claudeDir);
    settingsFile = path.join(claudeDir, 'settings.json');
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.XDG_CONFIG_HOME = path.join(root, 'config');
    process.env.APPDATA = path.join(root, 'config');
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const settings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));

  it('round-trips connect and disconnect, keeping other keys and the file mode', async () => {
    writeFileSync(settingsFile, JSON.stringify({ model: 'opus', statusLine: mine }), {
      mode: 0o600,
    });
    expect((await tapStatus()).state).toBe('disconnected');
    await connect(TAP);
    expect(settings()).toEqual({
      model: 'opus',
      statusLine: { type: 'command', command: TAP, refreshInterval: 10 },
    });
    const st = await tapStatus();
    expect(st.state).toBe('connected');
    expect(st.link?.previous).toEqual(mine);
    if (process.platform !== 'win32') expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    await disconnect();
    expect(settings()).toEqual({ model: 'opus', statusLine: mine });
    expect((await tapStatus()).link).toBeNull();
  });

  it('repairs a moved clone and never writes a settings.json that does not parse', async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ statusLine: { type: 'command', command: MOVED } }),
    );
    expect(await repair(TAP)).toBe(true);
    expect(settings().statusLine.command).toBe(TAP);
    expect(await repair(TAP)).toBe(false);

    writeFileSync(settingsFile, '{ broken');
    expect((await tapStatus()).state).toBe('unreadable');
    await expect(connect(TAP)).rejects.toThrow();
    expect(await repair(TAP)).toBe(false);
    expect(readFileSync(settingsFile, 'utf8')).toBe('{ broken');
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings.json', async () => {
    const target = path.join(claudeDir, 'dotfiles-settings.json');
    writeFileSync(target, '{}');
    symlinkSync(target, settingsFile);
    await connect(TAP);
    expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).statusLine.command).toBe(TAP);
  });
});
