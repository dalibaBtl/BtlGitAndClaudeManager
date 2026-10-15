import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPrepared,
  commitSteps,
  listPrepared,
  removePrepared,
  shellQuote,
  validatePrepared,
} from '../src/server/prepared.js';
import { chain } from '../src/server/terminal.js';

describe('prepared commit queue', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bgcm-prep-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('round-trips through the on-disk JSON format', async () => {
    const a = await addPrepared(dir, 'first\n\nbody', ['a.ts'], 'test');
    const b = await addPrepared(dir, 'second', [], 'claude');
    const list = await listPrepared(dir);
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
    const raw = JSON.parse(
      await readFile(path.join(dir, '.bgcm', 'prepared', `${a.id}.json`), 'utf8'),
    );
    expect(raw.version).toBe(1);
    await removePrepared(dir, a.id);
    expect((await listPrepared(dir)).map((p) => p.id)).toEqual([b.id]);
  });

  it('rejects malformed entries', () => {
    expect(validatePrepared(null)).toBeNull();
    expect(validatePrepared({ version: 2, id: 'x', message: 'm', files: [] })).toBeNull();
    expect(validatePrepared({ version: 1, id: '../x', message: 'm', files: [] })).toBeNull();
    expect(validatePrepared({ version: 1, id: 'x', message: '  ', files: [] })).toBeNull();
    expect(validatePrepared({ version: 1, id: 'x', message: 'm', files: [1] })).toBeNull();
    expect(validatePrepared({ version: 1, id: 'x', message: 'm', files: ['a'] })).toMatchObject({
      createdBy: 'unknown',
    });
  });

  it('builds quoted commit steps', () => {
    const steps = commitSteps(
      {
        version: 1,
        id: 'i',
        message: 'm',
        files: ["it's.ts", 'b c.ts'],
        createdBy: 't',
        createdAt: '',
      },
      '/tmp/msg.txt',
      new Set(["it's.ts", 'b c.ts']),
    );
    expect(steps).toEqual(["git add -A -- 'it''s.ts' 'b c.ts'", "git commit -F '/tmp/msg.txt'"]);
    expect(
      commitSteps(
        { version: 1, id: 'i', message: 'm', files: [], createdBy: 't', createdAt: '' },
        '/m',
        new Set(),
      ),
    ).toEqual(['git add -A', "git commit -F '/m'"]);
    expect(shellQuote('plain')).toBe("'plain'");
  });

  it('drops listed files that have no changes', () => {
    const item = {
      version: 1 as const,
      id: 'i',
      message: 'm',
      files: ['kept.ts', 'gone.ts', 'old.ts'],
      createdBy: 't',
      createdAt: '',
    };
    expect(commitSteps(item, '/m', new Set(['kept.ts', 'old.ts', 'new.ts']))).toEqual([
      "git add -A -- 'kept.ts' 'old.ts'",
      "git commit -F '/m'",
    ]);
    expect(() => commitSteps(item, '/m', new Set(['other.ts']))).toThrow('nothing to commit');
  });

  it('chains steps per shell dialect', () => {
    expect(chain(['a', 'b', 'c'], 'posix')).toBe('a && b && c');
    expect(chain(['a', 'b', 'c'], 'pwsh')).toBe('a && b && c');
    expect(chain(['a', 'b', 'c'], 'powershell-legacy')).toBe('a; if ($?) { b }; if ($?) { c }');
  });
});
