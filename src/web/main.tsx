import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { socket } from './api.js';
import { ContextMenu } from './components/ContextMenu.jsx';
import { Dialogs } from './components/Dialogs.jsx';
import { DiffView } from './components/DiffView.jsx';
import { FolderTree } from './components/FolderTree.jsx';
import { RepoTree } from './components/RepoTree.jsx';
import { TerminalPane } from './components/TerminalPane.jsx';
import { applyServerMessage, diffCollapsed, notices, selectRepo } from './state.js';
import './styles.css';

socket.onMessage(applyServerMessage);
socket.connect();

// `?repo=<path>` (set by `bgcm --repo`) opens the app directly on that repo once the scanner reports it.
const wantedRepo = new URLSearchParams(location.search).get('repo');
if (wantedRepo) {
  const off = socket.onMessage((m) => {
    if (m.type !== 'folders') return;
    const node = m.items.find((n) => n.path === wantedRepo && n.isRepo);
    if (node) {
      off();
      void selectRepo(node.path);
    }
  });
}

/** Pane sizes persisted per browser profile; purely cosmetic so localStorage is fine. */
function usePersistedSize(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      return Number(localStorage.getItem(key)) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n: number) => {
      setV(n);
      try {
        localStorage.setItem(key, String(n));
      } catch {
        // storage unavailable: keep the in-memory value
      }
    },
  ];
}

/** Drag handle that reports pointer movement along one axis. */
function Splitter({ axis, onMove }: { axis: 'x' | 'y'; onMove: (delta: number) => void }) {
  const last = useRef(0);
  return (
    <div
      class={`splitter ${axis}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = axis === 'x' ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        onMove(cur - last.current);
        last.current = cur;
      }}
    />
  );
}

/** Smallest useful widths; the middle pane is the one that must never collapse. */
const MIN_SIDE = 160;
const MIN_MIDDLE = 320;
const MIN_TERM = 60;
const MIN_REPO = 120;
/** Width of the strip the diff pane leaves at the right edge when collapsed. */
const COLLAPSED_WIDTH = 28;

/** Current viewport size, re-rendered on resize so pane sizes can be clamped to it. */
function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

function App() {
  const [leftPref, setLeft] = usePersistedSize('bgcm.left', 300);
  const [rightPref, setRight] = usePersistedSize('bgcm.right', 460);
  const [termPref, setTerm] = usePersistedSize('bgcm.term', 240);
  const { width, height } = useViewport();
  useEffect(() => {
    document.title = 'BTL Git & Claude Manager';
  }, []);

  // Clamp the stored preferences to what fits: in a narrow tile the side panes
  // shrink proportionally so the repo tree keeps MIN_MIDDLE, and the terminal
  // gives way to the repo tree rather than the other way round.
  const collapsed = diffCollapsed.value;
  const sideBudget = Math.max(2 * MIN_SIDE, width - MIN_MIDDLE - 12);
  const scale = Math.min(1, sideBudget / (leftPref + (collapsed ? 0 : rightPref)));
  const left = Math.max(MIN_SIDE, Math.floor(leftPref * scale));
  const right = collapsed ? COLLAPSED_WIDTH : Math.max(MIN_SIDE, Math.floor(rightPref * scale));
  const term = Math.max(MIN_TERM, Math.min(termPref, height - MIN_REPO - 6));

  return (
    <div
      class="app"
      style={{
        gridTemplateColumns: `${left}px 6px minmax(${MIN_MIDDLE}px, 1fr) ${collapsed ? 0 : 6}px ${right}px`,
      }}
    >
      <FolderTree />
      <Splitter axis="x" onMove={(d) => setLeft(Math.max(MIN_SIDE, left + d))} />
      <div class="middle" style={{ gridTemplateRows: `minmax(${MIN_REPO}px, 1fr) 6px ${term}px` }}>
        <RepoTree />
        <Splitter axis="y" onMove={(d) => setTerm(Math.max(MIN_TERM, term - d))} />
        <TerminalPane />
      </div>
      {collapsed ? (
        <div />
      ) : (
        <Splitter axis="x" onMove={(d) => setRight(Math.max(MIN_SIDE, right - d))} />
      )}
      <DiffView />
      <ContextMenu />
      <Dialogs />
      <div class="notices">
        {notices.value.map((n) => (
          <div key={n.id} class={`notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
