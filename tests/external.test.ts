import { describe, expect, it } from 'vitest';
import { terminalArgs } from '../src/server/external.js';

describe('terminalArgs', () => {
  const cmd = ['claude', '--resume', 'abc'];

  it('is empty without a command so the emulator just starts a shell in cwd', () => {
    expect(terminalArgs('kitty', '/d', [])).toEqual([]);
  });

  it('uses each emulator’s own directory and command flags', () => {
    expect(terminalArgs('kitty', '/d', cmd)).toEqual(['--directory', '/d', ...cmd]);
    expect(terminalArgs('alacritty', '/d', cmd)).toEqual([
      '--working-directory',
      '/d',
      '-e',
      ...cmd,
    ]);
    expect(terminalArgs('gnome-terminal', '/d', cmd)).toEqual([
      '--working-directory=/d',
      '--',
      ...cmd,
    ]);
    expect(terminalArgs('wezterm', '/d', cmd)).toEqual(['start', '--cwd', '/d', '--', ...cmd]);
    expect(terminalArgs('x-terminal-emulator', '/d', cmd)).toEqual(['-e', ...cmd]);
    expect(terminalArgs('something-else', '/d', cmd)).toEqual(['-e', ...cmd]);
  });
});
