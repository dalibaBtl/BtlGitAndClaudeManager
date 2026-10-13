#!/usr/bin/env node
// Status line tap: records Claude Code's rate-limit numbers where bgcm reads them,
// then shows the status line the user had before.
//
// Claude Code pipes a JSON payload to the status line command after each
// response (and every `refreshInterval` seconds). bgcm's panel connects this
// script as that command; the replaced `statusLine` is kept in
// `<config>/bgcm/statusline.json`, and its command runs here with the same
// payload on stdin, its output passed through untouched. With nothing to
// chain to, the tap prints the two percentages itself.
//
// It can also be piped into from a status line script by hand:
//
//   echo "$PAYLOAD" | node /path/to/bgcm/cli/statusline-tap.js --quiet
//
// The sample goes to `<cache>/bgcm/usage.json` as
// `{ seen, at, rate_limits }`: `seen` is the last payload of any kind, `at`
// and `rate_limits` the last one that carried limits (an API-key sign-in, or
// a session before its first response, has none and never erases them). The
// file is rewritten only when the numbers change or `seen` is a minute old.
//
// Every failure in recording is swallowed: the status line must never break
// because of bgcm. Deliberately standalone (no import of dist/server.js): it
// runs on every refresh of every session, so it has to start fast.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** How old `seen` may get before an unchanged sample is written again. */
const HEARTBEAT_MS = 60_000;

/** Must match `cacheDir()` in src/server/config.ts. */
function cacheDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'bgcm');
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'bgcm');
}

/** Must match `configDir()` in src/server/config.ts. */
function configDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'bgcm');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'bgcm');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes the sample when it says something new; returns the limits to display. */
function record(payload) {
  const dir = cacheDir();
  const file = path.join(dir, 'usage.json');
  const old = readJson(file) ?? {};
  const now = Date.now();
  const fresh = typeof payload.rate_limits === 'object' && payload.rate_limits !== null;
  const limits = fresh ? payload.rate_limits : (old.rate_limits ?? null);
  const changed = fresh && JSON.stringify(limits) !== JSON.stringify(old.rate_limits);
  if (changed || !(now - old.seen < HEARTBEAT_MS)) {
    const sample = { seen: now, at: fresh ? now : (old.at ?? null), rate_limits: limits };
    mkdirSync(dir, { recursive: true });
    // Write then rename, so the server never reads a half-written file.
    const tmp = path.join(dir, `usage.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(sample));
    renameSync(tmp, file);
  }
  return limits;
}

/** The replaced status line's command, when bgcm connected the tap in its place. */
function chained() {
  const prev = readJson(path.join(configDir(), 'statusline.json'))?.previous;
  return prev?.type === 'command' && typeof prev.command === 'string' ? prev.command : null;
}

function summary(limits) {
  const pct = (w) =>
    typeof w?.used_percentage === 'number' ? Math.round(w.used_percentage) : null;
  const parts = [];
  if (pct(limits?.five_hour) !== null) parts.push(`5h ${pct(limits.five_hour)}%`);
  if (pct(limits?.seven_day) !== null) parts.push(`7d ${pct(limits.seven_day)}%`);
  return parts.join(' · ');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let limits = null;
  try {
    limits = record(JSON.parse(input));
  } catch {
    // not JSON, unwritable cache dir, a concurrent rename on Windows: skip this sample
  }
  if (process.argv.includes('--quiet')) return;
  const command = chained();
  if (command === null) {
    process.stdout.write(summary(limits));
    return;
  }
  // The status line command is a shell command line; Claude Code runs it through a shell too.
  const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => process.exit(1));
  child.on('exit', (code) => process.exit(code ?? 1));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
});
