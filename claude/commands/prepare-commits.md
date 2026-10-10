---
description: Split uncommitted work into logical commits and queue them for BTL Git & Claude Manager (bgcm) — never commits, writes .bgcm/prepared/*.json
---

Argument: `$ARGUMENTS` — optional hint on how to split or what to include
(e.g. "one commit", "only the server changes").

Prepare commits for review in bgcm. Do **not** run `git add` or `git commit`;
the user sends each prepared commit to the terminal from the app.

Steps:

1. `git status --porcelain=v2 --untracked-files=all` and `git diff HEAD --stat`
   to see what changed. `git log -15 --format='%s'` to match the repo's
   message style (language, prefixes like `desktop:` / `feat:`, line length).
2. Group the changes into logical commits by _file sets_. Each file goes into
   exactly one commit. A commit can only contain whole files as they are on
   disk now, so do not plan "intermediate states" of the same file across
   commits. If the work is one coherent change, prepare one commit.
3. For every commit write `<repo>/.bgcm/prepared/<id>.json`:

   ```json
   {
     "version": 1,
     "id": "20261010-153000-session-titles",
     "message": "Session titles from transcripts\n\nWhy: ...\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
     "files": ["src/server/sessions.ts", "tests/sessions.test.ts"],
     "createdBy": "claude",
     "createdAt": "2026-10-10T15:30:00Z"
   }
   ```

   - `id`: `YYYYMMDD-HHMMSS-<slug>`, only `[A-Za-z0-9_-]`; it also fixes the
     order in the queue.
   - `files`: repo-relative, forward slashes, **always explicit** — never `[]`
     (that means "everything", which would also sweep in unrelated work).
     Deleted files belong in the list too; `git add -A -- <path>` stages the
     deletion.
   - `message`: subject ≤ 72 chars, blank line, body explaining _why_; end
     with the attribution trailer required by the session.
   - Create the directory if missing. Never touch `.git/`; the app adds
     `.bgcm/` to `.git/info/exclude` itself, and explicit `files` lists keep
     the JSON out of commits regardless.

4. Report the queue as a short list: `id — subject — n files`, and anything you
   left out of every commit (and why). Remind the user that commits run from
   bgcm in queue order and that editing a file after preparing changes what
   gets committed.
