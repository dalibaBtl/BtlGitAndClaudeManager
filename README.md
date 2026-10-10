# BTL Git & Claude Manager (bgcm)

Desktop tool for Linux and Windows that shows all your git repositories in one
place, finds Claude Code sessions, and keeps a queue of prepared commits that
you review and send to an embedded terminal.

```
+--------------+--------------------------------------+----------------+
| Folder tree  | Working tree | commit | commit | ...  | Diff           |
| (repos,      |              |        |        |      |                |
|  sessions)   +--------------------------------------+                |
|              | Terminal                             |                |
+--------------+--------------------------------------+----------------+
```

## Requirements

- Node.js 20 or newer
- `git` on `PATH`
- A Chromium-family browser (Chrome, Chromium, Edge, Brave) for the app window.
  Without one the UI opens in the default browser as a tab.
- Optional: `claude` on `PATH` to resume sessions from the UI.

## Install (any machine, after cloning)

```bash
git clone <this repo> && cd BtlGitAndClaudeManager
npm install
npm run build
npm run install-desktop      # adds "BTL Git & Claude Manager" to the app launcher
```

`install-desktop` writes a launcher entry with absolute paths to this clone
(Linux: `~/.local/share/applications/bgcm.desktop`; Windows: a Start Menu
shortcut), so Mod+D / rofi / the Start Menu start it with no terminal
involved. Re-run it after moving the clone; `npm run install-desktop -- --remove`
takes it out again. After `git pull`, run `npm install && npm run build` once.

Optional: `npm link` gives a `bgcm` command on `PATH`.

## Run

From the launcher, or from a shell:

```bash
npm start                      # starts the server in the background and opens the app window
node cli/bgcm.js --repo .      # open directly on the current repo
node cli/bgcm.js --no-open     # server only; prints the URL
node cli/bgcm.js --foreground  # keep the server attached to this terminal (debugging)
```

The launcher returns immediately; the server keeps running detached (log in
`~/.cache/bgcm/server.log`) and exits by itself ten seconds after the last
window is closed.

The app window is a Chromium app-mode window started with `--class=bgcm`
(X11 `WM_CLASS`); under Wayland Chrome reports its own `app_id`, so match on
the window title `BTL Git & Claude Manager` in sway/i3 rules instead. The
lightest option is `bgcm --no-open` and opening the printed URL as a tab in
the browser you already have running.

### Windows notes

The Start Menu shortcut runs `node.exe` minimized; its console disappears as
soon as the server detaches. The embedded terminal uses PowerShell 7 (`pwsh`)
when installed, otherwise Windows PowerShell.

## How it works

- A small Node server (`dist/server.js`) binds to `127.0.0.1` on a random
  port with a per-launch token. The UI is a static page served by it. The
  process exits ten seconds after the last window closes.
- Folders you add are scanned for repositories; scanning stops at each repo
  and skips dependency/build folders and dotfolders. Dirty counts are
  refreshed every minute, and the selected repo is watched for changes.
- Claude Code sessions are read from `~/.claude/projects` and matched to
  folders by the `cwd` recorded inside each transcript.
- Anything that might prompt (commit, push, pull, clone, `claude --resume`) is
  typed into the embedded terminal instead of run by the server, so SSH
  passphrases, hooks and signing behave exactly as in your shell.

## Prepared commits

A prepared commit is a JSON file in `<repo>/.bgcm/prepared/` (the folder is
added to `.git/info/exclude`, never to `.gitignore`). The UI lists them and
"Commit" types `git add … && git commit -F …` into the terminal. External tools,
including Claude Code, can queue commits by writing such a file:

```json
{
  "version": 1,
  "id": "any-unique-id",
  "message": "feat: add folder picker\n\nLonger body is optional.",
  "files": ["src/web/components/Dialogs.tsx"],
  "createdBy": "claude",
  "createdAt": "2026-10-10T08:00:00Z"
}
```

An empty `files` list means "stage everything".

### Letting Claude Code prepare commits

`claude/commands/prepare-commits.md` is a Claude Code slash command that
splits uncommitted work into logical commits and writes the JSON files above
instead of committing. Install it per user:

```bash
mkdir -p ~/.claude/commands
cp claude/commands/prepare-commits.md ~/.claude/commands/
```

Then, in any repo, `/prepare-commits` (optionally with a hint such as
`/prepare-commits "one commit"`) fills the queue, and you send each commit to
the terminal from bgcm.

## Development

```bash
npm run dev          # rebuild on change; run `npm start` in another shell
npm test             # vitest
npm run typecheck
npm run format
```
