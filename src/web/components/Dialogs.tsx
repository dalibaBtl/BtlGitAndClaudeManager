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

/** One button of a multiple-choice dialog. */
export interface Choice<T> {
  label: string;
  value: T;
  primary?: boolean;
}

interface ChoiceSpec {
  kind: 'choice';
  title: string;
  text: string;
  choices: Choice<unknown>[];
  resolve: (v: unknown) => void;
}

/** One row of a searchable pick list. */
export interface PickItem<T> {
  label: string;
  detail?: string;
  value: T;
}

interface PickSpec {
  kind: 'pick';
  title: string;
  placeholder: string;
  load: () => Promise<PickItem<unknown>[]>;
  resolve: (v: unknown) => void;
}

const current = signal<PromptSpec | PickerSpec | ConfirmSpec | ChoiceSpec | PickSpec | null>(null);

/** Asks the user to pick one of a few labelled actions; `null` when dismissed. */
export function askChoice<T>(title: string, text: string, choices: Choice<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    current.value = {
      kind: 'choice',
      title,
      text,
      choices,
      resolve: resolve as (v: unknown) => void,
    };
  });
}

/** Searchable list loaded lazily (e.g. from a CLI); resolves the chosen value or `null`. */
export function askPick<T>(
  title: string,
  placeholder: string,
  load: () => Promise<PickItem<T>[]>,
): Promise<T | null> {
  return new Promise((resolve) => {
    current.value = {
      kind: 'pick',
      title,
      placeholder,
      load: load as () => Promise<PickItem<unknown>[]>,
      resolve: resolve as (v: unknown) => void,
    };
  });
}

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
        {spec.kind === 'choice' && <ChoiceBody spec={spec} />}
        {spec.kind === 'pick' && <PickBody spec={spec} />}
      </div>
    </div>
  );
}

function ChoiceBody({ spec }: { spec: ChoiceSpec }) {
  return (
    <>
      <p>{spec.text}</p>
      <div class="dialog-actions">
        <button
          onClick={() => {
            spec.resolve(null);
            close();
          }}
        >
          Cancel
        </button>
        {spec.choices.map((c) => (
          <button
            key={c.label}
            class={c.primary ? 'primary' : ''}
            onClick={() => {
              spec.resolve(c.value);
              close();
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </>
  );
}

function PickBody({ spec }: { spec: PickSpec }) {
  const [items, setItems] = useState<PickItem<unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    spec
      .load()
      .then(setItems, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (it) => !q || it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q),
  );
  const choose = (it: PickItem<unknown>) => {
    spec.resolve(it.value);
    close();
  };
  return (
    <>
      <input
        ref={ref}
        placeholder={spec.placeholder}
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && shown[0] && choose(shown[0])}
      />
      <ul class="picker-list">
        {items === null && !error && <li class="empty">Loading…</li>}
        {error && <li class="empty">{error}</li>}
        {items && shown.length === 0 && <li class="empty">No matches</li>}
        {shown.slice(0, 200).map((it) => (
          <li key={it.label} onClick={() => choose(it)}>
            <span>{it.label}</span>
            {it.detail && <span class="detail">{it.detail}</span>}
          </li>
        ))}
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
      </div>
    </>
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
