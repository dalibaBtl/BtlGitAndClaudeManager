# ADR 0001: Tauri 2 stack and split git access

- **Status:** Superseded by [ADR 0002](0002-node-server-with-browser-app-window.md)
- **Date:** 2026-10-10

## Context

BTL Git and Claude Manager (see `docs/IDEA.md`) is a desktop app with these
requirements:

- It runs on **Linux and Windows** and is distributed as a **single
  executable**. It runs as a normal window or tile and can be started from the
  desktop launcher.
- It has a three-pane UI (folder tree, repo tree with commit columns, diff
  view) with an **embedded interactive terminal** under the repo tree. The
  terminal is where prepared commits are sent and where Claude Code sessions
  are opened.
- It scans arbitrarily large roots (possibly whole drives) for git repos and
  shows a live count of uncommitted files for each repo. With many repos, bulk
  status has to stay fast.
- It writes to git: commit, stash, `.gitignore` plus untrack, clone, and
  **push/pull to origin (GitHub)**. Writes must respect the user's existing
  credentials, SSH agent, hooks, commit signing, and LFS.

Stacks considered:

| Option            | Embedded terminal                                                              | Single file                                                  | Notes                                                                                      |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Avalonia / .NET 8 | No mature control. Would need a custom VT emulator plus ConPTY/forkpty interop | `PublishSingleFile`                                          | Best fit for the developer's main stack. The terminal alone is a project in its own right. |
| **Tauri 2 + TS**  | xterm.js + `portable-pty`, both mature                                         | Small binary; AppImage on Linux                              | Rust backend. Needs a WebView (WebView2 on Windows, WebKitGTK on Linux).                   |
| Electron + TS     | xterm.js + node-pty, both mature                                               | Large; "single file" only through AppImage or a portable exe | Heaviest runtime. Gives nothing over Tauri for this app.                                   |

Git access options considered:

- **CLI only**: exact parity with the user's git. However, running a process
  per repo for status across hundreds of repos is slow, and porcelain output
  has to be parsed.
- **Library only (libgit2 via `git2`)**: fast in-process reads. However,
  credentials (credential helpers, SSH agent, `gh` auth), hooks, signing, and
  LFS are partial or have to be reimplemented. Push is the weakest part.

## Decision

1. **Tauri 2** with a Rust backend (`src-tauri/`) and a TypeScript + React +
   Vite front-end using custom CSS. The terminal is xterm.js connected to
   `portable-pty`. Diffs are rendered with CodeMirror 6 `@codemirror/merge`.
2. **Split git access by direction:**
   - **Reads** (repo discovery, status counts, file trees, diffs, history)
     use the `git2` crate, called in-process and run in parallel across repos.
   - **Writes and network** (commit, stash, ignore/untrack, clone, push,
     pull) shell out to the `git` CLI.
   - A single write operation never mixes the two. After any CLI write, state
     is re-read through `git2`.

## Consequences

- The embedded terminal and single-binary packaging come from existing
  components, and effort goes into the trees, the prepared-commit queue, and
  scanning performance.
- Push/pull and commits behave exactly like they do in the user's terminal.
  The app holds no credentials and contains no authentication code.
- `git` must be on `PATH` for write operations. The app has to detect a
  missing `git` and say so clearly instead of failing obscurely.
- libgit2 and git CLI can disagree on edge cases (new index extensions, sparse
  checkout, unusual config). Reads may lag behind newer git features. If that
  becomes a problem, the read side can move to `gix` (gitoxide) without
  touching the write side.
- The codebase has two languages (Rust and TypeScript), which is outside the
  developer's main .NET stack. Tauri commands define the boundary, and inputs
  are validated on the Rust side.
- Runtime dependencies: Windows needs WebView2, which ships with Windows
  10/11. The Linux AppImage depends on the system's WebKitGTK. Launcher (Mod+D)
  integration on Linux requires installing a `.desktop` entry, because an
  AppImage does not register one by itself.
