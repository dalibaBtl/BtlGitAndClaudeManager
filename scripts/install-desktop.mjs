// Registers bgcm with the desktop launcher of the current user, using absolute
// paths so it works regardless of what PATH the launcher inherits (nvm, custom
// npm prefix). Linux: an XDG .desktop entry. Windows: a Start Menu shortcut.
// Re-running updates the entry; `--remove` deletes it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'cli', 'bgcm.js');
const node = process.execPath;
const remove = process.argv.includes('--remove');
const name = 'BTL Git & Claude Manager';

if (!existsSync(path.resolve(here, '..', 'dist', 'server.js'))) {
  console.error('dist/ is missing; run `npm run build` first');
  process.exit(1);
}

if (process.platform === 'linux') {
  const dir = path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'applications',
  );
  const file = path.join(dir, 'bgcm.desktop');
  if (remove) {
    rmSync(file, { force: true });
    console.log(`removed ${file}`);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${name}`,
        'Comment=Git repo visualizer and Claude Code session finder',
        `Exec=${quote(node)} ${quote(cli)}`,
        `Path=${path.dirname(cli)}`,
        'Icon=utilities-terminal',
        'Terminal=false',
        'Categories=Development;RevisionControl;',
        'StartupWMClass=bgcm',
        'Keywords=git;claude;repo;',
        '',
      ].join('\n'),
    );
    console.log(`wrote ${file}`);
  }
  try {
    execFileSync('update-desktop-database', [dir], { stdio: 'ignore' });
  } catch {
    // Optional; launchers rescan the directory on their own.
  }
} else if (process.platform === 'win32') {
  const dir = path.join(
    process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  const file = path.join(dir, `${name.replace(/&/g, 'and')}.lnk`);
  if (remove) {
    rmSync(file, { force: true });
    console.log(`removed ${file}`);
  } else {
    // WindowStyle 7 = minimized: the console of the launcher process is only
    // visible for the fraction of a second before it detaches and exits.
    const ps = [
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BGCM_LNK)',
      '$s.TargetPath = $env:BGCM_NODE',
      "$s.Arguments = '\"' + $env:BGCM_CLI + '\"'",
      '$s.WorkingDirectory = $env:BGCM_CWD',
      '$s.WindowStyle = 7',
      '$s.Description = $env:BGCM_NAME',
      '$s.Save()',
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'inherit',
      env: {
        ...process.env,
        BGCM_LNK: file,
        BGCM_NODE: node,
        BGCM_CLI: cli,
        BGCM_CWD: path.dirname(cli),
        BGCM_NAME: name,
      },
    });
    console.log(`wrote ${file}`);
  }
} else {
  console.error(`no launcher integration for ${process.platform}; run ${cli} directly`);
  process.exit(1);
}

/** Quotes a path for the `Exec=` key, which splits on spaces and honours double quotes. */
function quote(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}
