// Renders the UI components to static HTML with populated state. There is no
// browser in CI, so this is the cheapest way to catch runtime errors in the
// view code and to assert the key rendering rules (colours, filters, grouping).
import { render } from 'preact-render-to-string';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  // The API client reads these at import time.
  Object.assign(globalThis, {
    location: { search: '?t=test', origin: 'http://127.0.0.1:1' },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
    },
  });
});

async function load() {
  const state = await import('../src/web/state.js');
  const { FolderTree } = await import('../src/web/components/FolderTree.jsx');
  const { RepoTree } = await import('../src/web/components/RepoTree.jsx');
  const { DiffView } = await import('../src/web/components/DiffView.jsx');
  return { state, FolderTree, RepoTree, DiffView };
}

describe('FolderTree', () => {
  it('colours repos, shows dirty counts and sessions, honours hidden and dirty-only', async () => {
    const { state, FolderTree } = await load();
    state.config.value = { roots: ['/dev'], hidden: ['/dev/hidden'] };
    state.folders.value = new Map(
      [
        { path: '/dev', parent: null, name: '/dev', isRepo: false, hasChildren: true },
        { path: '/dev/clean', parent: '/dev', name: 'clean', isRepo: true, hasChildren: false },
        { path: '/dev/dirty', parent: '/dev', name: 'dirty', isRepo: true, hasChildren: false },
        { path: '/dev/plain', parent: '/dev', name: 'plain', isRepo: false, hasChildren: false },
        { path: '/dev/hidden', parent: '/dev', name: 'hidden', isRepo: true, hasChildren: false },
        { path: '/dev/ahead', parent: '/dev', name: 'ahead', isRepo: true, hasChildren: false },
        { path: '/dev/synced', parent: '/dev', name: 'synced', isRepo: true, hasChildren: false },
      ].map((n) => [n.path, n]),
    );
    state.summaries.value = new Map([
      [
        '/dev/clean',
        { path: '/dev/clean', branch: 'main', upstream: null, ahead: 0, behind: 0, dirtyCount: 0 },
      ],
      [
        '/dev/ahead',
        {
          path: '/dev/ahead',
          branch: 'main',
          upstream: 'o/main',
          ahead: 1,
          behind: 2,
          dirtyCount: 0,
        },
      ],
      [
        '/dev/synced',
        {
          path: '/dev/synced',
          branch: 'main',
          upstream: 'o/main',
          ahead: 0,
          behind: 0,
          dirtyCount: 0,
        },
      ],
      [
        '/dev/dirty',
        {
          path: '/dev/dirty',
          branch: 'wip',
          upstream: 'o/wip',
          ahead: 2,
          behind: 0,
          dirtyCount: 3,
        },
      ],
    ]);
    state.sessions.value = [
      { id: 's1', cwd: '/dev/dirty', file: '/x', modified: Date.now(), label: 'Fix things' },
    ];

    let html = render(<FolderTree />);
    // Colour state: dirty beats unpushed beats no-upstream beats synced.
    expect(html).toContain('class="row repo  dirty "');
    expect(html).toContain('class="row repo  ahead "');
    expect(html).toContain('class="row repo  local "');
    expect(html).toContain('class="row repo  synced "');
    expect(html).toContain('<b> (3)</b>');
    expect(html).toContain('<i class="ahead"> ↑2</i>');
    expect(html).toContain('<i class="behind"> ↓2</i>');
    expect(html).toContain('class="legend"');
    // A repo with sessions is expandable (collapsed by default); one without is not.
    expect(html).toContain('<span class="caret ">▸</span><span class="name">dirty</span>');
    expect(html).toContain('<span class="caret blank"></span><span class="name">clean</span>');
    expect(html).not.toContain('>hidden<');
    expect(html).toContain('>plain<');

    state.dirtyOnly.value = true;
    html = render(<FolderTree />);
    expect(html).toContain('>dirty<');
    expect(html).not.toContain('>clean<');
    expect(html).not.toContain('>plain<');
    state.dirtyOnly.value = false;

    // Tree modes: "git" hides folders without repos; "claude" keeps only paths to sessions.
    state.treeMode.value = 'git';
    html = render(<FolderTree />);
    expect(html).toContain('>clean<');
    expect(html).not.toContain('>plain<');
    expect(html).toContain('dirty only'); // still offered in git mode
    state.treeMode.value = 'claude';
    html = render(<FolderTree />);
    expect(html).toContain('check disabled'); // dirty-only stays in place, just disabled
    expect(html).toContain('>dirty<');
    expect(html).not.toContain('>clean<');
    expect(html).not.toContain('>synced<');
    state.treeMode.value = 'both';
    expect(state.sessionsByFolder.value.get('/dev/dirty')?.map((s) => s.id)).toEqual(['s1']);

    // A session whose folder no longer exists gets ghost folders down to its cwd;
    // a session outside every root is not placed at all.
    state.sessions.value = [
      ...state.sessions.value,
      { id: 's2', cwd: '/dev/gone/deeper', file: '/y', modified: 1, label: 'Old session' },
      { id: 's3', cwd: '/elsewhere/x', file: '/z', modified: 1, label: 'Foreign' },
    ];
    expect(state.treeNodes.value.get('/dev/gone')).toMatchObject({ parent: '/dev', ghost: true });
    expect(state.treeNodes.value.get('/dev/gone/deeper')).toMatchObject({
      parent: '/dev/gone',
      name: 'deeper',
      ghost: true,
    });
    // Foreign paths (other machine, other OS) hang under the virtual root with their full path.
    expect(state.treeNodes.value.get('/elsewhere')).toMatchObject({
      parent: state.UNPLACED_ROOT,
      name: '/elsewhere',
      ghost: true,
    });
    state.sessions.value = [
      ...state.sessions.value,
      { id: 's4', cwd: 'C:\\Users\\bob\\proj', file: '/w', modified: 1, label: 'Windows one' },
    ];
    expect(state.treeNodes.value.get('C:')).toMatchObject({ parent: state.UNPLACED_ROOT });
    expect(state.treeNodes.value.get('C:\\Users\\bob\\proj')).toMatchObject({
      parent: 'C:\\Users\\bob',
      name: 'proj',
    });
    html = render(<FolderTree />);
    expect(html).toMatch(/row folder\s+ghost/);
    expect(html).toContain('>missing<');
    expect(html).toContain('Sessions from unknown paths');
    expect(html).toContain('>/elsewhere<');
    state.treeMode.value = 'git';
    html = render(<FolderTree />);
    expect(html).not.toContain('>gone<');
    expect(html).not.toContain('Sessions from unknown paths');
    state.treeMode.value = 'both';
  });
});

describe('RepoTree', () => {
  it('renders working tree with status colours, the queue, commit columns and nested sessions', async () => {
    const { state, RepoTree } = await load();
    state.selectedRepo.value = '/dev/dirty';
    state.repoStatus.value = {
      path: '/dev/dirty',
      branch: 'wip',
      upstream: null,
      ahead: 0,
      behind: 1,
      dirtyCount: 2,
    };
    state.repoFiles.value = [
      {
        path: 'src/a.ts',
        ignored: false,
        status: { path: 'src/a.ts', index: '.', worktree: 'M', kind: 'ordinary' },
      },
      {
        path: 'src/new.ts',
        ignored: false,
        status: { path: 'src/new.ts', index: '.', worktree: '?', kind: 'untracked' },
      },
      { path: 'README.md', ignored: false },
      {
        path: 'debug.log',
        ignored: true,
        status: { path: 'debug.log', index: '.', worktree: '!', kind: 'ignored' },
      },
    ];
    state.prepared.value = [
      {
        version: 1,
        id: 'p1',
        message: 'feat: queue\n\nbody',
        files: ['src/a.ts'],
        createdBy: 'claude',
        createdAt: '',
      },
    ];
    state.commits.value = [
      {
        sha: 'abc123def',
        shortSha: 'abc123d',
        author: 'Jan',
        time: 1_700_000_000,
        subject: 'initial',
        message: 'initial',
        isHead: true,
        pushed: false,
        files: [{ status: 'A', path: 'src/a.ts' }],
      },
    ];
    state.sessions.value = [
      {
        id: 's2',
        cwd: '/dev/dirty/src',
        file: '/y',
        modified: Date.now(),
        label: 'Nested session',
      },
    ];
    state.hideIgnored.value = true;

    let html = render(<RepoTree />);
    expect(html).toContain('st-M');
    expect(html).toContain('st-?');
    expect(html).toContain('st-clean');
    expect(html).not.toContain('debug.log');
    expect(html).toContain('feat: queue');
    expect(html).toContain('1 file(s) · claude');
    expect(html).toContain('column commit');
    expect(html).toContain('abc123d · Jan');
    expect(html).not.toContain('Nested session'); // sessions are never part of a commit
    expect(html).toContain('↓1');

    state.changedOnly.value = true;
    html = render(<RepoTree />);
    expect(html).not.toContain('README.md');
    expect(html).toContain('a.ts');
    state.changedOnly.value = false;

    state.hideIgnored.value = false;
    html = render(<RepoTree />);
    expect(html).toContain('debug.log');
  });
});

describe('DiffView', () => {
  it('renders hunks with line numbers and add/del classes', async () => {
    const { state, DiffView } = await load();
    state.selectedFile.value = 'src/a.ts';
    state.diffText.value = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ].join('\n');
    let html = render(<DiffView />);
    expect(html).toContain('class="line del"');
    expect(html).toContain('class="line add"');
    expect(html).toContain('const b = 3;');
    expect(html).toContain('@@ -1,2 +1,2 @@');

    state.diffCollapsed.value = true;
    html = render(<DiffView />);
    expect(html).toContain('diff-pane collapsed');
    expect(html).not.toContain('const b = 3;');
    // Selecting a file reveals the pane again.
    void state.selectFile('src/a.ts', null);
    expect(state.diffCollapsed.value).toBe(false);
  });
});
