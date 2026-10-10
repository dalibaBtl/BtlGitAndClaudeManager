import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import { onPath } from './external.js';

/**
 * Shell dialect of the embedded terminal. It decides how app-generated
 * commands are chained and how files are removed; quoting with `'…'` is common
 * to all three.
 */
export type ShellKind = 'posix' | 'pwsh' | 'powershell-legacy';

/**
 * One interactive shell bound to a WebSocket client.
 *
 * Commands the app wants the user to run (commit, push, pull, clone, resume a
 * Claude session) are *typed* into this shell rather than executed by the
 * server. That keeps credential prompts, hooks and signing visible and
 * interactive, and it leaves a record in the shell history.
 */
export class Terminal {
  private readonly proc: IPty;
  readonly kind: ShellKind;

  constructor(
    cwd: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ) {
    const shell = defaultShell();
    this.kind = shell.kind;
    this.proc = pty.spawn(shell.cmd, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >,
    });
    this.proc.onData(onData);
    this.proc.onExit(({ exitCode }) => onExit(exitCode));
  }

  /** Sends raw keystrokes. */
  write(data: string): void {
    this.proc.write(data);
  }

  /**
   * Types a sequence of commands as one line and presses Enter. Each step runs
   * only if the previous one succeeded; Windows PowerShell 5.1 has no `&&`, so
   * there the chain is expressed with `$?` checks.
   */
  runChain(steps: string[]): void {
    this.proc.write(chain(steps, this.kind) + '\r');
  }

  /** Shell command that deletes a file without prompting, in this shell's dialect. */
  removeFileCommand(quotedPath: string): string {
    return this.kind === 'posix' ? `rm -f ${quotedPath}` : `Remove-Item -Force ${quotedPath}`;
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(Math.max(2, cols), Math.max(1, rows));
  }

  kill(): void {
    this.proc.kill();
  }
}

/** Joins steps so that each runs only after the previous succeeded. */
export function chain(steps: string[], kind: ShellKind): string {
  if (kind !== 'powershell-legacy') return steps.join(' && ');
  return steps.map((s, i) => (i === 0 ? s : `if ($?) { ${s} }`)).join('; ');
}

/**
 * Picks the shell: the user's login shell on Unix; on Windows PowerShell 7
 * (`pwsh`) when installed because it supports `&&`, else Windows PowerShell.
 */
function defaultShell(): { cmd: string; args: string[]; kind: ShellKind } {
  if (process.platform === 'win32') {
    if (onPath('pwsh.exe')) return { cmd: 'pwsh.exe', args: ['-NoLogo'], kind: 'pwsh' };
    return { cmd: 'powershell.exe', args: ['-NoLogo'], kind: 'powershell-legacy' };
  }
  return { cmd: process.env.SHELL || '/bin/bash', args: ['-l'], kind: 'posix' };
}
