import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

/** One entry of a context menu; `danger` renders in the warning colour. */
export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

const menu = signal<MenuState | null>(null);

/** Opens the global context menu at the mouse position of `ev`. */
export function openMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault();
  ev.stopPropagation();
  menu.value = items.length > 0 ? { x: ev.clientX, y: ev.clientY, items } : null;
}

/** Renders the single app-wide context menu; closes on any click, Escape or scroll. */
export function ContextMenu() {
  const m = menu.value;
  useEffect(() => {
    if (!m) return;
    const close = () => (menu.value = null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
    };
  }, [m]);
  if (!m) return null;
  const x = Math.min(m.x, window.innerWidth - 240);
  const y = Math.min(m.y, window.innerHeight - m.items.length * 30 - 16);
  return (
    <ul
      class="menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {m.items.map((it) => (
        <li
          key={it.label}
          class={`${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (it.disabled) return;
            menu.value = null;
            it.onClick();
          }}
        >
          {it.label}
        </li>
      ))}
    </ul>
  );
}
