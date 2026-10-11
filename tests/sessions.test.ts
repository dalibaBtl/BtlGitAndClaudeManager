import { describe, expect, it } from 'vitest';
import { encodeProjectDir, parseSessionHead } from '../src/server/sessions.js';

describe('parseSessionHead', () => {
  it('takes cwd and id from records, prefers the stored summary as label', () => {
    const text = [
      JSON.stringify({ type: 'mode', sessionId: 'abc-123' }),
      JSON.stringify({ type: 'summary', summary: 'Fix the  scanner' }),
      JSON.stringify({
        type: 'user',
        cwd: '/home/u/dev/BTL_Machines',
        sessionId: 'abc-123',
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n');
    const s = parseSessionHead(text, '/x/abc-123.jsonl', 42);
    expect(s).toMatchObject({
      id: 'abc-123',
      cwd: '/home/u/dev/BTL_Machines',
      label: 'Fix the scanner',
      modified: 42,
    });
  });

  it('falls back to the first user prompt and strips system reminders', () => {
    const text = [
      JSON.stringify({
        type: 'user',
        cwd: '/p',
        message: {
          content: [
            { type: 'text', text: '<system-reminder>noise</system-reminder>' },
            { type: 'text', text: 'Please refactor the thing' },
          ],
        },
      }),
      '{"type":"assistant","trunc',
    ].join('\n');
    const s = parseSessionHead(text, '/x/f.jsonl', 1);
    expect(s?.label).toBe('Please refactor the thing');
    expect(s?.id).toBe('f');
  });

  it('keeps the slash command name from a command envelope', () => {
    const text = JSON.stringify({
      type: 'user',
      cwd: '/p',
      message: {
        content:
          '<command-message>init</command-message>\n<command-name>/init</command-name>\n<command-args></command-args>',
      },
    });
    expect(parseSessionHead(text, '/x/f.jsonl', 1)?.label).toBe('/init');
  });

  it('skips an image-only first turn and labels from the next text turn', () => {
    const text = [
      JSON.stringify({
        type: 'user',
        cwd: '/p',
        message: { content: [{ type: 'image', source: {} }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ignored' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'what is this linux image?' }] },
      }),
    ].join('\n');
    expect(parseSessionHead(text, '/x/f.jsonl', 1)?.label).toBe(
      '(image) what is this linux image?',
    );
    const imageOnly = JSON.stringify({
      type: 'user',
      cwd: '/p',
      message: { content: [{ type: 'image', source: {} }] },
    });
    expect(parseSessionHead(imageOnly, '/x/f.jsonl', 1)?.label).toBe('(image)');
  });

  it('prefers the custom title, taking the latest one from the tail', () => {
    const head = [
      JSON.stringify({ type: 'custom-title', customTitle: 'old name', sessionId: 'f' }),
      JSON.stringify({ type: 'summary', summary: 'A summary' }),
      JSON.stringify({ type: 'user', cwd: '/p', message: { content: 'first prompt' } }),
    ].join('\n');
    expect(parseSessionHead(head, '/x/f.jsonl', 1)?.label).toBe('old name');
    const tail = [
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'linux image', sessionId: 'f' }),
      JSON.stringify({ type: 'assistant' }),
      '{"type":"custom-title","customTitle":"trunc',
    ].join('\n');
    expect(parseSessionHead(head, '/x/f.jsonl', 1, tail)?.label).toBe('linux image');
  });

  it('picks the cwd whose encoding matches the project folder name', () => {
    const file = '/home/u/.claude/projects/-home-u-dev-New/f.jsonl';
    const head = [
      JSON.stringify({ type: 'user', cwd: '/home/u/dev/Old', message: { content: 'first' } }),
      JSON.stringify({ type: 'user', cwd: '/home/u/dev/New', message: { content: 'resumed' } }),
    ].join('\n');
    expect(parseSessionHead(head, file, 1)?.cwd).toBe('/home/u/dev/New');
    const tail = [
      JSON.stringify({ type: 'assistant', cwd: '/home/u/dev/New/sub/dir' }),
      '{"type":"user","cwd":"/home/u/dev/Trunc',
    ].join('\n');
    expect(parseSessionHead(head, file, 1, tail)?.cwd).toBe('/home/u/dev/New');
  });

  it('keeps the project when the shell moved into a subfolder or elsewhere', () => {
    const file = '/home/u/.claude/projects/-home-u-dev/f.jsonl';
    const head = [
      JSON.stringify({ type: 'user', cwd: '/home/u/dev', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', cwd: '/home/u/dev/Other.Repo_x' }),
    ].join('\n');
    expect(parseSessionHead(head, file, 1)?.cwd).toBe('/home/u/dev');
  });

  it('falls back to the first cwd when none matches the folder, as for a moved file', () => {
    const head = JSON.stringify({ type: 'user', cwd: '/p/old', message: { content: 'x' } });
    expect(parseSessionHead(head, '/x/f.jsonl', 1)?.cwd).toBe('/p/old');
  });

  it('encodes a cwd like the project folder name', () => {
    expect(encodeProjectDir('/home/u/dev/Eplan.EplAddin_Bom Editor')).toBe(
      '-home-u-dev-Eplan-EplAddin-Bom-Editor',
    );
  });

  it('uses the generated ai-title when there is no custom title', () => {
    const head = [
      JSON.stringify({ type: 'user', cwd: '/p', message: { content: 'first prompt' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Old generated', sessionId: 'f' }),
    ].join('\n');
    expect(parseSessionHead(head, '/x/f.jsonl', 1)?.label).toBe('Old generated');
    const tail = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Sway background', sessionId: 'f' }),
      JSON.stringify({ type: 'assistant' }),
    ].join('\n');
    expect(parseSessionHead(head, '/x/f.jsonl', 1, tail)?.label).toBe('Sway background');
    const renamed = tail + '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'mine' });
    expect(parseSessionHead(head, '/x/f.jsonl', 1, renamed)?.label).toBe('mine');
  });

  it('returns null when no record carries a cwd', () => {
    expect(parseSessionHead('{"type":"mode"}\n', '/x/f.jsonl', 1)).toBeNull();
  });
});
