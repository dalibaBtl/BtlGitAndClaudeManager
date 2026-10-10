import { describe, expect, it } from 'vitest';
import { parseSessionHead } from '../src/server/sessions.js';

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

  it('returns null when no record carries a cwd', () => {
    expect(parseSessionHead('{"type":"mode"}\n', '/x/f.jsonl', 1)).toBeNull();
  });
});
