import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * Launches external programs (file manager, terminal emulator, default app)
 * detached from this process so they outlive the server.
 */

/** Opens `target` (file or directory) with the platform default handler. */
export function openWithDefault(target: string): void {
  if (process.platform === 'win32') {
    detached('cmd', ['/c', 'start', '', target]);
  } else if (process.platform === 'darwin') {
    detached('open', [target]);
  } else {
    detached('xdg-open', [target]);
  }
}

/**
 * Opens a terminal emulator with its working directory set to `dir`, running
 * `command` in it when given (otherwise the user's shell). The window stays
 * open after the command exits only where the emulator supports it.
 */
export function openTerminal(dir: string, command: string[] = []): void {
  if (process.platform === 'win32') {
    if (onPath('wt.exe')) detached('wt.exe', ['-d', dir, ...command]);
    else
      detached('cmd', [
        '/c',
        'start',
        '',
        'cmd',
        '/K',
        [`cd /d "${dir}"`, ...command].join(' && '),
      ]);
    return;
  }
  if (process.platform === 'darwin') {
    if (command.length > 0) throw new Error('running a command in Terminal.app is not supported');
    detached('open', ['-a', 'Terminal', dir]);
    return;
  }
  const preferred = process.env.TERMINAL;
  const candidates = [
    preferred,
    'x-terminal-emulator',
    'kitty',
    'alacritty',
    'foot',
    'wezterm',
    'gnome-terminal',
    'konsole',
    'xterm',
  ].filter((c): c is string => Boolean(c));
  const term = candidates.find(onPath);
  if (!term) throw new Error('no terminal emulator found; set $TERMINAL');
  detached(term, terminalArgs(path.basename(term), dir, command), dir);
}

/**
 * Per-emulator argument shape. The cwd is also inherited from the spawn, so
 * emulators without a directory flag still start in the right place. Unknown
 * emulators get the de-facto `-e` convention.
 */
export function terminalArgs(term: string, dir: string, command: string[]): string[] {
  if (command.length === 0) return [];
  switch (term) {
    case 'kitty':
      return ['--directory', dir, ...command];
    case 'alacritty':
      return ['--working-directory', dir, '-e', ...command];
    case 'foot':
      return ['--working-directory', dir, ...command];
    case 'wezterm':
      return ['start', '--cwd', dir, '--', ...command];
    case 'gnome-terminal':
      return [`--working-directory=${dir}`, '--', ...command];
    case 'konsole':
      return ['--workdir', dir, '-e', ...command];
    default:
      return ['-e', ...command];
  }
}

function detached(cmd: string, args: string[], cwd?: string): void {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/** Whether an executable with this name exists on `PATH`. */
export function onPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        accessSync(path.join(d, name + ext), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}
