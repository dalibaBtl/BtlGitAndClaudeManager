# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

`bgcm`: a desktop tool (Linux + Windows) that visualizes git repos across many
folders, finds Claude Code sessions, and keeps a queue of prepared commits the
user sends to an embedded terminal. Product spec: `docs/IDEA.md` (Czech; **the
UI is English only**). Architecture decisions: `docs/adr/` (0002 is current).
User-facing docs: `README.md`.

## Commands

```bash
npm run build                      # esbuild: dist/server.js + dist/web/
npm start                          # build must exist; starts server, opens app window
node cli/bgcm.js --no-open         # server only, prints URL (use for API testing)
node cli/bgcm.js --foreground      # server attached to the terminal instead of detached
npm run install-desktop            # launcher entry with absolute paths (scripts/install-desktop.mjs)
node cli/bgcm.js --repo .          # open directly on a repo
npm run dev                        # rebuild on change (run `npm start` separately)
npm test                           # vitest, all
npx vitest run tests/diff.test.ts -t "binary"   # one file / one test
npm run typecheck                  # tsc --noEmit over src + tests
npm run format                     # prettier --write
```

Node 20 is the floor (`vitest` is pinned to 3.x for that reason; 4+/5+ need Node 22).
`node_modules/`, `dist/`, and `bin/` are off-limits to edits and reads; use
`npm view <pkg>` for package metadata.

## Architecture

Three processes at runtime: a **Node server** (`src/server/`), a **browser
page** (`src/web/`, Preact + signals, served by the server), and a **shell in
a pty** per connected page. Contracts between them are in
`src/shared/types.ts`; parsers shared by both sides live in `src/shared/`.

### Server (`src/server/main.ts` is the hub)

- `App` holds all state in memory (folders, repos, summaries, sessions) and
  replays a snapshot to every new WebSocket client. HTTP is for request/
  response (`/api/*`), the WebSocket for pushes and the terminal.
- Every request needs the per-launch token (`?t=` or `x-bgcm-token`). Repo
  paths in requests are validated against the scanner's known set
  (`assertRepo`); never run git on a path the scanner has not reported.
- **Two classes of git operation, do not mix them:**
  - _Direct_: reads (`git.ts`), plus stash / ignore+untrack / init, which
    never prompt. Run via `execFile`, output parsed (`shared/porcelain.ts`,
    `shared/diff.ts`).
  - _Typed into the terminal_: commit, push, pull, clone, `claude --resume`.
    Built in `App.buildSteps`, chained per shell dialect in `terminal.ts`
    (`&&` on POSIX/pwsh, `$?` checks on Windows PowerShell 5.1). Anything
    that can prompt for credentials or open an editor belongs here.
- `scanner.ts`: breadth-first, bounded concurrency, stops at `.git`, skips
  `SKIP_DIRS` and dotfolders below the root. `watch.ts`: only the _selected_
  repo is watched (recursive `fs.watch`, debounced, `.git` noise filtered).
  Everything else is re-summarised on a 60 s timer. Keep it that way; watching
  every repo under a drive-sized root is the one thing that would make the
  app heavy.
- `sessions.ts`: `~/.claude/projects/<encoded>/<id>.jsonl`. The encoded dir
  name is lossy (`/` and `_` both become `-`), so the real folder comes from
  the `cwd` field inside the records. Only the first 256 KB of a transcript is
  read; results cache on mtime+size.
- `prepared.ts`: `<repo>/.bgcm/prepared/<id>.json`, schema `PreparedCommit`
  (`version: 1`). This is a **public contract** for external tools; bump
  `version` on incompatible changes and keep `validatePrepared` strict. The
  directory is excluded via `.git/info/exclude`, never `.gitignore`.

### Web (`src/web/`)

- `state.ts`: all signals plus the actions (`selectRepo`, `reloadRepo`,
  `selectFile`, `loadDiff`) and `applyServerMessage`. Components read signals
  directly; they do not own server state.
- Panes: `FolderTree` (roots → folders → repos, sessions in orange),
  `RepoTree` (working-tree column with the `PreparedQueue`, then one column
  per commit), `DiffView`, `TerminalPane` (xterm.js). `ContextMenu` and
  `Dialogs` are app-wide singletons driven by `openMenu()` / `askText()` /
  `askFolder()` / `askConfirm()`.
- Paths in the UI are opaque strings echoed back to the server; use
  `shared/paths.ts` helpers (`joinNative`, `isWithin`, `relativeTo`) rather
  than string surgery, so Windows paths keep working.

### Launcher (`cli/bgcm.js`)

Re-spawns itself detached with `--foreground` (stdout piped only until the
URL arrives, stderr to `<cache>/bgcm/server.log`), prints the URL and exits.
The child opens a Chromium app-mode window with a dedicated profile under the
cache dir (separate process from the user's browser, no extensions). The server
exits 10 s after the last client disconnects unless `--keep-alive`/`--no-open`.

## Testing

- `tests/` is vitest. Pure modules have unit tests; `tests/ui.test.tsx`
  renders components with `preact-render-to-string` against populated signals
  (no DOM, no browser), which is how UI regressions are caught here.
- For end-to-end checks, start `node cli/bgcm.js --no-open --port <n>` with
  `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` pointed at a scratch dir and drive
  `/api/*` with curl; the token is the `t` query parameter of the printed URL.
- Headless Chrome cannot reach loopback from this sandbox, so there is no
  screenshot-based verification; do not spend time on it.
