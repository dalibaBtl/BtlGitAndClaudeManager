import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { guard } from '../state.js';

/**
 * Promise-based modal dialogs. Each `ask*` function resolves with the user's
 * answer or `null` when dismissed, so call sites read linearly.
 */

interface PromptSpec {
  kind: 'prompt';
  title: string;
  label: string;
  initial: string;
  multiline: boolean;
  okLabel: string;
  resolve: (v: string | null) => void;
}

interface PickerSpec {
  kind: 'picker';
  title: string;
  start: string;
  resolve: (v: string | null) => void;
}

interface ConfirmSpec {
  kind: 'confirm';
  title: string;
  text: string;
  okLabel: string;
  resolve: (v: boolean) => void;
}

const current = signal<PromptSpec | PickerSpec | ConfirmSpec | null>(null);

export function askText(
  title: string,
  label: string,
  opts: { initial?: string; multiline?: boolean; okLabel?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    current.value = {
      kind: 'prompt',
      title,
      label,
      initial: opts.initial ?? '',
      multiline: opts.multiline ?? false,
      okLabel: opts.okLabel ?? 'OK',
      resolve,
    };
  });
}

export function askFolder(title: string, start: string): Promise<string | null> {
  return new Promise((resolve) => {
    current.value = { kind: 'picker', title, start, resolve };
  });
}

export function askConfirm(title: string, text: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = { kind: 'confirm', title, text, okLabel, resolve };
  });
}

function close(): void {
  current.value = null;
}

/** Hosts whichever dialog is open. Escape dismisses, clicking the backdrop dismisses. */
export function Dialogs() {
  const spec = current.value;
  useEffect(() => {
    if (!spec) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (spec.kind === 'confirm') spec.resolve(false);
        else spec.resolve(null);
        close();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [spec]);
  if (!spec) return null;
  return (
    <div
      class="backdrop"
      onClick={() => {
        if (spec.kind === 'confirm') spec.resolve(false);
        else spec.resolve(null);
        close();
      }}
    >
      <div class="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{spec.title}</h2>
        {spec.kind === 'prompt' && <PromptBody spec={spec} />}
        {spec.kind === 'picker' && <PickerBody spec={spec} />}
        {spec.kind === 'confirm' && <ConfirmBody spec={spec} />}
      </div>
    </div>
  );
}

function PromptBody({ spec }: { spec: PromptSpec }) {
  const [value, setValue] = useState(spec.initial);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    if (value.trim() === '') return;
    spec.resolve(value);
    close();
  };
  return (
    <>
      <label>{spec.label}</label>
      {spec.multiline ? (
        <textarea
          ref={ref as { current: HTMLTextAreaElement | null }}
          rows={6}
          value={value}
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
        />
      ) : (
        <input
          ref={ref as { current: HTMLInputElement | null }}
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
      <div class="dialog-actions">
        {spec.multiline && <span class="hint">Ctrl+Enter to confirm</span>}
        <button
          onClick={() => {
            spec.resolve(null);
            close();
          }}
        >
          Cancel
        </button>
        <button class="primary" onClick={submit} disabled={value.trim() === ''}>
          {spec.okLabel}
        </button>
      </div>
    </>
  );
}

function ConfirmBody({ spec }: { spec: ConfirmSpec }) {
  return (
    <>
      <p>{spec.text}</p>
      <div class="dialog-actions">
        <button
          onClick={() => {
            spec.resolve(false);
            close();
          }}
        >
          Cancel
        </button>
        <button
          class="primary"
          onClick={() => {
            spec.resolve(true);
            close();
          }}
        >
          {spec.okLabel}
        </button>
      </div>
    </>
  );
}

interface Listing {
  path: string;
  parent: string | null;
  dirs: string[];
}

/** Server-backed directory browser; the browser itself cannot see the filesystem. */
function PickerBody({ spec }: { spec: PickerSpec }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState(spec.start);

  const load = (p: string) =>
    guard(async () => {
      const l = await api.get<Listing>('/api/fs/list', { path: p });
      setListing(l);
      setTyped(l.path);
    });

  useEffect(() => void load(spec.start), []);
  const sep = typed.includes('\\') ? '\\' : '/';
  const join = (base: string, name: string) =>
    base.endsWith(sep) ? base + name : base + sep + name;

  return (
    <>
      <div class="picker-path">
        <input
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && load(typed)}
        />
        <button onClick={() => listing?.parent && load(listing.parent)} disabled={!listing?.parent}>
          Up
        </button>
      </div>
      <ul class="picker-list">
        {listing?.dirs.map((d) => (
          <li key={d} onClick={() => load(join(listing.path, d))}>
            {d}
          </li>
        ))}
        {listing && listing.dirs.length === 0 && <li class="empty">No subfolders</li>}
      </ul>
      <div class="dialog-actions">
        <button
          onClick={() => {
            spec.resolve(null);
            close();
          }}
        >
          Cancel
        </button>
        <button
          class="primary"
          disabled={!listing}
          onClick={() => {
            if (!listing) return;
            spec.resolve(listing.path);
            close();
          }}
        >
          Select this folder
        </button>
      </div>
    </>
  );
}
