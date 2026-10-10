import { describe, expect, it } from 'vitest';
import { baseName, isWithin, joinNative, relativeTo } from '../src/shared/paths.js';

describe('path helpers', () => {
  it('work with both separators', () => {
    expect(baseName('/home/u/dev/x')).toBe('x');
    expect(baseName('C:\\dev\\x\\')).toBe('x');
    expect(baseName('/')).toBe('/');
    expect(joinNative('/r', 'a/b.ts')).toBe('/r/a/b.ts');
    expect(joinNative('C:\\r\\', 'a/b.ts')).toBe('C:\\r\\a\\b.ts');
    expect(isWithin('/r', '/r/x')).toBe(true);
    expect(isWithin('/r', '/rx')).toBe(false);
    expect(isWithin('/r', '/r')).toBe(true);
    expect(relativeTo('/r', '/r/a/b')).toBe('a/b');
    expect(relativeTo('C:\\r', 'C:\\r\\a\\b')).toBe('a/b');
    expect(relativeTo('/r', '/other')).toBeNull();
  });
});
