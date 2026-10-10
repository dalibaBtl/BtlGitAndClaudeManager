import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../shared/types.js';

/**
 * Directory holding user configuration: `$XDG_CONFIG_HOME/bgcm` on Unix,
 * `%APPDATA%\bgcm` on Windows.
 */
export function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'bgcm');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'bgcm');
}

/**
 * Directory for disposable per-user data (browser profile, caches):
 * `$XDG_CACHE_HOME/bgcm` on Unix, `%LOCALAPPDATA%\bgcm` on Windows.
 */
export function cacheDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'bgcm');
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'bgcm');
}

const CONFIG_FILE = 'config.json';

/** Loads the config, returning defaults when the file is missing or unreadable. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(path.join(configDir(), CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      roots: Array.isArray(parsed.roots) ? parsed.roots.filter(isString) : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(isString) : [],
    };
  } catch {
    return { roots: [], hidden: [] };
  }
}

/** Writes the config atomically enough for a single-user desktop app (write then rename is overkill here). */
export async function saveConfig(config: AppConfig): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
