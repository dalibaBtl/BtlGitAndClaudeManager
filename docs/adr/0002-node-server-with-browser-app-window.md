# ADR 0002: Node server with a browser app window, git CLI only

- **Status:** Accepted, supersedes [ADR 0001](0001-tauri-stack-and-split-git-access.md)
- **Date:** 2026-10-10

## Context

ADR 0001 chose Tauri 2 with a Rust backend. When implementation started the
build machine had no Rust toolchain and no WebKitGTK development headers, and
installing them requires root. More importantly, the requirement that drove
the choice was "light on resources", and on a developer desktop a browser is
already running. Re-evaluated against that:

| Option                       | Marginal RAM on a desktop with a browser open                                                             | Build toolchain                | Terminal                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------- |
| Tauri 2                      | WebView process (~80–150 MB) + Rust binary                                                                | Rust + WebKitGTK/WebView2 SDKs | xterm.js + portable-pty |
| Electron                     | Own Chromium (~200 MB+)                                                                                   | Node                           | xterm.js + node-pty     |
| **Node server + app window** | Node (~40 MB) + a Chromium app window (~100 MB), or ~0 as a tab in the already-open browser (`--no-open`) | Node only                      | xterm.js + node-pty     |

Git access in ADR 0001 was split between `git2` (reads) and the CLI (writes).
Without Rust there is no libgit2 binding worth using from Node (`nodegit` is
unmaintained; `isomorphic-git` is slower than the CLI for status).

## Decision

1. **Runtime: Node 20 server + browser app window.** `dist/server.js` serves
   the UI and the API on `127.0.0.1` with a per-launch token. The launcher
   opens it as a Chromium app-mode window (`--app=`) with its own small
   profile and extensions disabled; without a Chromium-family browser it falls
   back to the default browser. The server exits shortly after the last window
   closes, so the app behaves like a desktop program rather than a daemon.
2. **Front-end: Preact + signals, esbuild, custom CSS.** No framework beyond
   the 4 kB renderer; one bundle, no dev server.
3. **Git: CLI only.** Reads use `git status --porcelain=v2 -z` and friends
   with bounded parallelism (8 processes) across repos. Operations that may
   prompt or run long (commit, push, pull, clone) are typed into the embedded
   terminal (node-pty + xterm.js) instead of executed by the server. Stash,
   ignore/untrack and `git init` run directly because they never prompt.
   Claude Code sessions are launched in the user's external terminal
   emulator: inside a browser page Chromium keeps shortcuts such as Ctrl+W
   and Ctrl+T, which collide with Claude Code's key bindings.
4. **Watching: only the selected repo** is watched with a debounced recursive
   `fs.watch`; all other repos are re-summarised once a minute. Sessions are
   indexed by reading the head of each transcript and cached by mtime/size.
5. **Prepared commits** live in `<repo>/.bgcm/prepared/*.json`, excluded via
   `.git/info/exclude`, with a versioned schema so external tools can write them.

## Consequences

- Builds and runs with Node alone; no native toolchain except node-gyp for
  `node-pty` on Linux (prebuilt binaries ship for Windows and macOS).
- "Single executable" from the spec becomes "single `npm start`/`bgcm`
  command with Node installed". A Node SEA bundle is possible later but the
  native pty addon complicates it, and the benefit is small for a developer
  machine that already has Node.
- UI runs with the browser's own sandbox and renderer; keyboard shortcuts that
  Chromium reserves (Ctrl+W, Ctrl+T) are not available to the app.
- Git parity is exact because every operation goes through the user's `git`;
  there is no second implementation to diverge. Status across hundreds of
  repos costs one short-lived process each, which is acceptable at the
  one-minute refresh cadence.
- The server trusts its token holder completely (it can read any directory and
  run shell commands through the terminal). The token is random per launch and
  the server only listens on loopback, so other users and other web pages
  cannot reach it; this is the same trust model as a local IDE.
